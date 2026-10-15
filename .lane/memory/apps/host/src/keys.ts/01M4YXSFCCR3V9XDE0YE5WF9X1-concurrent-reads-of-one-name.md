---
id: 01M4YXSFCCR3V9XDE0YE5WF9X1
anchor: function keychain
created: 2026-10-15T04:40:39Z
norm: '1'
sig: c9fd7fb26ded5e08
body_hash: c513d2326b05fd04
raw_hash: 9cb762881738adfb
lines: 57-71
---

concurrent reads of one name share a single in-flight Bun.secrets.get, so a person sees at most one prompt across Settings, directory syncs, and moves
