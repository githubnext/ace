---
id: 01M4YV0FE7PXPDBFTKP9ADMXTD
anchor: function retryLoginShell
created: 2026-10-15T03:52:02Z
norm: '1'
sig: 668da89511308fa7
body_hash: 8607d7ded1d30c44
raw_hash: 0444035cb2defd92
lines: 58-72
---

a late adoption reintroduces the shell's credentials into process.env; its callback must seal them in the same tick, before any worker spawns
