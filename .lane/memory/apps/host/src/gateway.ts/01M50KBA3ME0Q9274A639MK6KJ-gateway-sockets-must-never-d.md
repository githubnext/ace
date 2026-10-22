---
id: 01M50KBA3ME0Q9274A639MK6KJ
anchor: function websocket
created: 2026-10-15T20:16:37Z
norm: '1'
sig: 1b462e5d3bc33728
body_hash: e4839023c586ff4f
raw_hash: cda22d4980cf5a80
vouched: 2026-10-22T00:00:58Z
lines: 673-737
---

gateway sockets must never drop a frame silently; past the backpressure limit they close so the client reconnects and re-watches
