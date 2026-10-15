---
id: 01M4ZHBX7QSQ80PQ8ZKSCK37JC
anchor: const sync
created: 2026-10-15T10:22:45Z
norm: '1'
supersedes: 01M4YX72ZF09QKX1XJ0CWEPTZV
---

Refresh (diagnostics sync), a directory change, and the heartbeat join an in-flight sync for the same URL; only a channel change queues one follow-up sync, since the running one may have read channels before it. A sync for an old URL never holds a directory change, which keeps Join/Change/Leave from waiting on a keychain prompt
