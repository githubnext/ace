---
id: 01M50KBA3ME0Q9274A639MK6KJ
anchor: function websocket
created: 2026-10-15T20:16:37Z
norm: '1'
sig: 1b462e5d3bc33728
body_hash: aee7bf28626367fb
raw_hash: 6675f75b614405d9
lines: 673-737
---

gateway sockets must never drop a frame silently; past the backpressure limit they close so the client reconnects and re-watches
