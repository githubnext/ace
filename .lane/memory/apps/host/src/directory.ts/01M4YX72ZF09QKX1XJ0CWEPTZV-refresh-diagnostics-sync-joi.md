---
id: 01M4YX72ZF09QKX1XJ0CWEPTZV
anchor: const sync
created: 2026-10-15T04:30:36Z
norm: '1'
---

Refresh (diagnostics sync) joins an in-flight sync for the same URL instead of starting a second one; a sync for an old URL never holds a directory change, which keeps Join/Change/Leave from waiting on a keychain prompt
