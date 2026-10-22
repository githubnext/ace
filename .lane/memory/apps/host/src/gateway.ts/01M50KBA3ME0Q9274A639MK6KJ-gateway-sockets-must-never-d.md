---
id: 01M50KBA3ME0Q9274A639MK6KJ
anchor: function websocket
created: 2026-10-15T20:16:37Z
norm: '1'
sig: 1b462e5d3bc33728
body_hash: 39ee5954e9b924c2
raw_hash: 0abdf1cfc47ee529
vouched: 2026-10-22T14:33:27Z
lines: 673-737
---

gateway sockets must never drop a frame silently; past the backpressure limit they close so the client reconnects and re-watches
