---
id: 01M50KBA3ME0Q9274A639MK6KJ
anchor: function websocket
created: 2026-10-15T20:16:37Z
norm: '1'
sig: 1b462e5d3bc33728
body_hash: 4e6ce6a0eaa1ee2f
raw_hash: fd92f6b6617f653e
vouched: 2026-10-22T15:28:03Z
lines: 673-737
---

gateway sockets must never drop a frame silently; past the backpressure limit they close so the client reconnects and re-watches
