---
id: 01M50KBA3ME0Q9274A639MK6KJ
anchor: function websocket
created: 2026-10-15T20:16:37Z
norm: '1'
sig: 1b462e5d3bc33728
body_hash: 39bbd535e37f47a0
raw_hash: c1a585dfb617245a
vouched: 2026-10-20T17:10:51Z
lines: 673-737
---

gateway sockets must never drop a frame silently; past the backpressure limit they close so the client reconnects and re-watches
