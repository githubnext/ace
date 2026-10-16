# Ace

A collaborative coding environment where people and agents work together in channels that run on
your own machines.

## Security — read this first

> [!WARNING]
> Ace runs agents with the privileges of the user running the host. They can execute arbitrary
> shell commands and read, change, or delete files beyond the project directory. Channels and
> lanes are not security sandboxes.

**Your tailnet is your team and the sole authority for team membership and collaboration access.**
Ace has no separate accounts, invitations, or team access controls. Only allow people and machines
you trust with access to your host to reach Ace over your tailnet.

New channels start with collaborator agent invocation off: teammates can read channel history and
post messages, but not invoke agents. Turning it on with `bun ace share <channel> on` or the
channel header lets teammates run commands as you on its host. `bun ace share <channel> off`
blocks new collaborator invocations; active work continues. Native desktop tools also start off;
the owner turns them on from the channel header or with `bun ace desktop <channel> on`, and an
agent that needs them asks first.
Disabling them does not restrict shell access.

Keep the host's gateway on loopback or your private tailnet. **Do not expose it to the public
internet** through Tailscale Funnel, port forwarding, or a public reverse proxy. Protect local
owner tokens and the team's `ACE_SECRET` as credentials for the access they grant: the team's
services are reachable from the internet, and their tailnet scope is
[not a security boundary](docs/architecture.md#the-team). Read
[the trust model](docs/architecture.md#the-team) before running or sharing Ace.

Ace is open source software for teams to clone, fork, and operate themselves. Any shared services
are deployed by the team in its own infrastructure or cloud account. Ace will not operate a
hosted service.

## Run

Requires Bun 1.4 or later and a model provider key. Ace reads a key such as `OPENAI_API_KEY` from
`ACE_OPENAI_API_KEY`, then `OPENAI_API_KEY`, then the OS keychain (`bun ace key set OPENAI_API_KEY`).

```sh
bun install
bun ace new --project ~/code/my-repo
bun ace ask <channel> "what does this repo do?"
bun ace --help
```

The app runs in a browser against the host's gateway, or as the macOS desktop app:

```sh
bun app build && bun ace serve   # start the local host
bun ace open                     # in another terminal: open its authenticated browser app
bun desktop dev                  # desktop UI and the independent Ace Helper
bun desktop build                # stable artifacts; distribution signing is still required
```

Open Settings in the app to check, save, replace, or remove Anthropic and OpenAI keys in Keychain.
The default model is shared with the CLI's `ace model` command. Provider keys are never returned
to the UI, and running workers read changes on their next model request. Environment overrides
still take priority and are identified in Settings.

Press Cmd+O in the desktop to open a folder as a project. Opening a project needs no provider key
and creates no channel. Dashboard and Channels share the project picker; start a channel from
the project's dashboard or sidebar. Each project remembers its selected channel.

Settings → This Mac shows Git, shell, and Tailscale status, joins the
[team directory](#team-directory), has Start, Stop, and Restart controls for Ace Helper, and installs
the command line tool. Install links `ace` for stable, or `ace-canary` for Canary, in
`~/.local/bin` to the app's own Ace Helper, so it uses that app's channels and port with no
environment variables and stays current with app updates. Settings says whether your shell finds it
and, if not, what to add to your `PATH`. Remove deletes only that link.
Quitting the UI leaves hosting available. Stopping the helper takes local channels offline and suspends
their work; restarting it and reopening a channel resumes that work.

Development desktop builds use their own catalog, settings, and Keychain service (`ace-dev`).
The installed stable app and CLI use `ace`. Build with Bun 1.4 or later; the packaged UI uses
Electrobun's compatible bundled runtime, and Ace Helper carries its own compiled runtime.

If `bun desktop dev` or `build` exits silently, macOS killed Electrobun's downloaded CLI for an invalid
signature. Re-sign it once with `codesign --force -s - apps/desktop/node_modules/electrobun/bin/electrobun`.

Start Tailscale to collaborate: the host shares its channels over the tailnet, and the app shows
teammates' channels. Local work can run without Tailscale; remote collaboration uses the tailnet.

On your phone or another of your devices, with Tailscale on, open the address the host prints
(`http://<machine>.<tailnet>.ts.net:4140`). Only the host's owner is served; Tailscale names the
person behind each connection. Teammates open their own host, which shows your channels.

When the tailnet has HTTPS certificates, hosts also listen on HTTPS (port + 1000) and the deployed
web app can reach them. Deploy it with `bun --filter @ace/app deploy`, then name it in the team's
directory (`printf %s https://ace-app.<your-subdomain>.workers.dev | bunx wrangler secret put APP`
in `services/directory`), so every host that joins the directory allows it. A host without a
directory uses `bun ace web <url>` instead, which also overrides the directory's. Open the app and
enter `<machine>.<tailnet>.ts.net:5140`. Add it to the home screen to use it as an app.

A hosted channel lives in a Durable Object deployed by your team and runs its tools on the host
that created it, while that host runs `ace serve` or the desktop app. To try one locally, put
`ACE_SECRET`, `TAILNET` (your tailnet's MagicDNS suffix), and a model key in
`services/channel/.dev.vars`, then:

```sh
bun --filter @ace/channel-service dev                     # http://localhost:8787
printf %s "$SECRET" | bun ace key set ACE_SECRET          # the value in .dev.vars
bun ace new --hosted http://localhost:8787 --project ~/code/my-repo
```

### Team directory

The team's directory lists every host's channels, so they stay visible while their host sleeps.
Whoever sets up the team deploys it once from a checkout; everyone else joins from the app.

To try it locally, run `services/directory` the same way
(`bun --filter @ace/directory dev --port 8788`) and point each host at `http://localhost:8788`.

To deploy both services to your Cloudflare account, give the Workers the same secret and your
tailnet's MagicDNS suffix (`tailscale status --json | jq -r .MagicDNSSuffix`). The services
then serve only that tailnet; another tailnet needs new deployments.

```sh
SECRET=$(openssl rand -hex 32)
TAILNET=$(tailscale status --json | jq -r .MagicDNSSuffix)
for s in channel directory; do (cd services/$s && bunx wrangler deploy && printf %s "$SECRET" | bunx wrangler secret put ACE_SECRET && printf %s "$TAILNET" | bunx wrangler secret put TAILNET); done
(cd services/channel && bunx wrangler secret put ANTHROPIC_API_KEY)   # and any other model keys
```

Share the directory's URL (`https://ace-directory.<your-subdomain>.workers.dev`) and the secret
with teammates privately. Every host, including yours, joins in Settings → This Mac → Team
directory: Ace Helper checks the URL and secret against the directory, then saves the secret to
the Keychain. Change or leave the directory, or remove the saved secret, in the same place. The
row shows the directory's URL, the last successful sync, and the last sync's error until a sync
succeeds; Troubleshooting → Refresh status syncs at once.

Name the hosting service in the directory so every host offers it in a channel's Move to menu:
`printf %s https://ace-channel.<your-subdomain>.workers.dev | bunx wrangler secret put HOSTED` in
`services/directory`.

From a checkout, `printf %s "$SECRET" | bun ace key set ACE_SECRET` then `bun ace directory <url>`
does the same. While Ace Helper or `ace serve` runs, both go through it: macOS asks before a signed
Ace Helper reads a Keychain item another program, such as `bun` or `security`, saved.

## Documentation

- [Terms](docs/terms.md): what Ace's words mean. Binding.
- [Architecture](docs/architecture.md): how channels, hosts, and shared services fit together.
- [Desktop plan](docs/desktop.md): packaging, settings, onboarding, and distribution.
- [Native desktop inspection](docs/desktop-tools.md): inspect macOS windows with Peekaboo.
- [Browser tools](docs/browser-tools.md): list, navigate, and inspect pages in a dedicated browser.
