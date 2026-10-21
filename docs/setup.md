# Setup

Start Tailscale before Ace Helper. Every channel belongs to the tailnet it was created on, and a
host shows only its current tailnet's channels, so a host without Tailscale creates none. Restart
Ace Helper after switching tailnets.

## Provider keys

Add Anthropic or OpenAI keys in `Settings → Providers`, which stores them in Keychain. Provider keys
are never returned to the UI, and running workers read changes on their next model request.

From a checkout, Ace reads a key such as `OPENAI_API_KEY` from `ACE_OPENAI_API_KEY`, then
`OPENAI_API_KEY`, then the OS keychain (`bun ace key set OPENAI_API_KEY`). Environment overrides
take priority and Settings identifies them.

## Command line tool

`Settings → This Mac` installs the command line tool. It links `ace` for stable, or `ace-canary`
for Canary, in `~/.local/bin` to the app's own Ace Helper, so it uses that app's channels and port
and stays current with app updates. Settings says whether your shell finds it and, if not, what to
add to your `PATH`.

## From a checkout

Ace requires Bun 1.4 or later.

```sh
bun install
bun ace new --project ~/code/my-repo
bun ace ask <channel> "what does this repo do?"
bun app build && bun ace serve   # start the local host
bun ace open                     # in another terminal: open its authenticated browser app
bun desktop dev                  # desktop UI and the independent Ace Helper
```

Development builds use their own catalog, settings, and Keychain service; see
[desktop](desktop.md#ui-testing). If `bun desktop dev` or `build` exits silently, macOS killed
Electrobun's downloaded CLI for an invalid signature. Re-sign it once with
`codesign --force -s - apps/desktop/node_modules/electrobun/bin/electrobun`.

## Other devices

On your phone or another of your devices, with Tailscale on, open the address the host prints
(`http://<machine>.<tailnet>.ts.net:4140`). Only the host's owner is served. Teammates open their
own host, which shows your channels.

When the tailnet has HTTPS certificates, hosts also listen on HTTPS (port + 1000) and the team's
deployed web app can reach them: open it, enter `<machine>.<tailnet>.ts.net:5140`, and add it to the
home screen to use it as an app.

## Team directory

The team's directory lists every host's channels, so they stay visible while their host sleeps.
Whoever sets up the team deploys the services once from a checkout; everyone else joins in
`Settings → This Mac → Team directory` with the directory's URL and the team's secret, shared
privately. `Troubleshooting → Refresh status` syncs at once. From a checkout,
`printf %s "$SECRET" | bun ace key set ACE_SECRET` then `bun ace directory <url>` does the same.

The services are cells, so they run on Cloudflare Workers, or on [celld](#on-celld) on machines the
team runs or on [Fly.io](#on-flyio). To deploy them to your Cloudflare account, give the Workers the same secret and your
tailnet's MagicDNS suffix. The services then serve only that tailnet; see
[the team](architecture.md#the-team) for what that scope does and doesn't protect.

```sh
SECRET=$(openssl rand -hex 32)
TAILNET=$(tailscale status --json | jq -r .MagicDNSSuffix)
for s in channel directory; do (cd services/$s && bunx wrangler deploy && printf %s "$SECRET" | bunx wrangler secret put ACE_SECRET && printf %s "$TAILNET" | bunx wrangler secret put TAILNET); done
(cd services/channel && bunx wrangler secret put ANTHROPIC_API_KEY)   # and any other model keys
```

Then name the other services in the directory, from `services/directory`, so every host that joins
picks them up:

- `HOSTED`: the channel service (`https://ace-channel.<your-subdomain>.workers.dev`), offered in a
  channel's `Move to` menu.
- `APP`: the web app, deployed with `bun --filter @ace/app deploy`. A host without a directory uses
  `bun ace web <url>` instead.
- `COMPUTE`: the [compute service](../services/compute/README.md), which turns on `Run in cloud`
  for every host that hasn't saved its own `Settings → Beta` choice.

```sh
printf %s https://ace-channel.<your-subdomain>.workers.dev | bunx wrangler secret put HOSTED
```

### On celld

celld runs the same services on any machine with an S3, R2, GCS, Tigris, or Azure Blob bucket.
Until [denoland/celld#277](https://github.com/denoland/celld/issues/277) lands, install the
[githubnext/celld](https://github.com/githubnext/celld) build, which fixes runs failing with
"Session is poisoned":

```sh
curl -fsSL https://celld.dev/install.sh | CELLD_RELEASES_URL=https://github.com/githubnext/celld/releases sh
```

Put each service's vars in a file (`ACE_SECRET`, `TAILNET`, model keys for `channel`, and `HOSTED`,
`APP`, or `COMPUTE` for `directory`), deploy each under its own prefix, and run a node per prefix.
celld has no secret store: the vars sit in the bucket as plain text, so restrict who can read it.

```sh
bun services/celld.ts channel deploy channel.env --bucket s3://my-bucket/channel
bun services/celld.ts directory deploy directory.env --bucket s3://my-bucket/directory
celld --bucket s3://my-bucket/channel --listen 127.0.0.1:8788      # one node per service
celld --bucket s3://my-bucket/directory --listen 127.0.0.1:8787
tailscale serve --bg --https 8443 http://127.0.0.1:8788            # celld serves no TLS
tailscale serve --bg --https 443 http://127.0.0.1:8787
```

Hosts then use `https://<machine>.<tailnet>.ts.net` as the directory and
`https://<machine>.<tailnet>.ts.net:8443` as `HOSTED`. Redeploying updates running nodes without a
restart. Compute still needs Cloudflare.

### On Fly.io

[`services/fly.toml`](../services/fly.toml) runs one celld node per service on Fly.io, with a
Tigris bucket each. Tigris needs a card on the Fly account. Pick app names (`ace-directory-<team>`
and `ace-channel-<team>` below), then create the apps and buckets. `fly storage create` prints the
bucket's keys once; keep them to deploy from a checkout.

```sh
for s in directory channel; do
	fly apps create ace-$s-<team>
	fly storage create -a ace-$s-<team> -n ace-$s-<team>
	fly secrets set -a ace-$s-<team> --stage CELLD_BUCKET=s3://ace-$s-<team>
done
```

Deploy each service's code to its bucket with that bucket's keys, then start its node. Set `HOSTED`
in `directory.env` to `https://ace-channel-<team>.fly.dev`.

```sh
export S3_ENDPOINT=https://fly.storage.tigris.dev AWS_REGION=auto
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… bun services/celld.ts channel deploy channel.env --bucket s3://ace-channel-<team>
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… bun services/celld.ts directory deploy directory.env --bucket s3://ace-directory-<team>
fly deploy -c services/fly.toml -a ace-channel-<team> --ha=false
fly deploy -c services/fly.toml -a ace-directory-<team> --ha=false
```

Hosts then use `https://ace-directory-<team>.fly.dev` as the directory. The URLs are public, like
`workers.dev`, and refuse requests without the team's credential.

To try the services locally, put `ACE_SECRET`, `TAILNET`, and a model key in
`services/channel/.dev.vars`, then:

```sh
bun --filter @ace/channel-service dev                     # http://localhost:8787
bun --filter @ace/directory dev --port 8788               # point hosts at http://localhost:8788
printf %s "$SECRET" | bun ace key set ACE_SECRET          # the value in .dev.vars
bun ace new --hosted http://localhost:8787 --project ~/code/my-repo
```

`bun services/celld.ts <channel|directory> dev --port <port>` runs a service on celld instead, reading
its `.dev.vars`.
