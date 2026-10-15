---
id: 01M4YV0FE7PXPDBFTKP9ADMXTD
anchor: function retryLoginShell
created: 2026-10-15T03:52:02Z
norm: '1'
---

a late adoption reintroduces the shell's credentials into process.env; its callback must seal them in the same tick, before any worker spawns
