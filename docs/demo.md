# Demo mode

`ace demo` shows Ace with nothing of yours: a fresh clone of the Beats drum machine
([githubnext/beats-demo](https://github.com/githubnext/beats-demo)), its `add-dark-theme` and
`delay-effect` channels, and the synthetic teammates idan, davidslater and agorischek, who type,
talk, react and ask the channel agent, whose answers come from the script. The script plays once.
Cloning needs access to githubnext; `--project <dir>` clones a local copy of Beats instead. The
agent's `lane` calls need the [lane CLI](https://lane.lukeed.com/usage/) on the host's PATH, which
the Mac app ships.
In the Mac app, File → Pause Demo holds the steps not yet started (typing and agent runs already
underway finish), Resume Demo continues from there, and Restart Demo puts back the seeded project
and channels and plays the script from the start. It runs its own
loopback host on port 4150 (`--port` picks another) in a temporary home that it removes when it
stops, and uses no keys, models or Tailscale. Open the sign-in link it prints. From a checkout, build the app first with `bun app build`.

`ace serve --demo <script.json>` runs scripted synthetic teammates on this host, for recordings.
They are present in projects and channels, and they post, ask agents and react through ordinary
channel requests, which each channel admits by its own rules: an ask needs the channel's agent
access on, as a real teammate's would. Only their identities are made up, and only in the owner's
own app; the directory, lobbies and peers never see them. File → Restart Demo replays the script
without reseeding.

The installed app runs demo mode when its home holds `demo.json`, such as
`~/.local/state/ace-canary/demo.json` for Canary; restart Ace after adding or removing it.

Seed the channels first with `ace import` (see [channel data](data.md#seeds)).

```json
{
	"people": {
		"alex": { "login": "alex", "github": "octocat" }
	},
	"steps": [
		{ "at": 0, "who": "alex", "open": true, "channel": "checkout" },
		{ "at": 1, "who": "alex", "type": 2, "channel": "checkout" },
		{
			"at": 3,
			"who": "alex",
			"say": "pushed a fix, can someone check?",
			"image": "checkout.png",
			"channel": "checkout"
		},
		{
			"at": 6,
			"who": "alex",
			"ask": "does the fix handle a missing quantity?",
			"channel": "checkout"
		},
		{ "at": 9, "who": "alex", "react": "👀", "channel": "checkout" },
		{ "at": 30, "who": "alex", "away": true },
		{ "at": 60, "who": "alex", "leave": true }
	],
	"loop": 30
}
```

- `login` is the author their messages carry; `github` picks the avatar and name the app shows.
- `at` is seconds from the start. `loop` restarts the script that many seconds after its last step.
- Steps: `open`/`close` a channel (present there), `away` true or false, `leave`, `type` (shows
  them typing for that many seconds), `say`, `ask`, and `react`, which reacts to the chat's newest
  message or reply. Acting opens the channel first. A `say` may attach an `image`, a PNG or JPEG
  path from the script's folder.
  `chat` targets a chat other than the root.
- Under `ace demo`, an `ask` may carry the agent's `reply` and optional `thinking`. The agent answers
  any message containing an ask's text with that reply, and anything else with a note that this is a
  demo. Before replying it works through the ask's optional `work`: each turn may `say` something,
  then makes `calls`, each a `tool` such as `read` or `bash` with its `args`. The channel runs them
  for real in the demo project, so keep them true to the reply; edits belong in a lane.
