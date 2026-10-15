---
id: 01M4YYBPG1N4M7X28J28129STP
anchor: function look
created: 2026-10-15T04:50:36Z
norm: '1'
sig: 7be76d87e39cd5df
body_hash: d4884c8b89c33e3a
raw_hash: 6265485424664b46
lines: 120-145
---

Settings reads keychain names one at a time; model availability asks for ~40 names, so parallel reads could raise many prompts at once. Bun.secrets has no existence check that skips the item ACL, so names cannot be filtered before reading.
