---
id: 01M4ZN6VY85JFQK61DKGR4E8K3
anchor: '@file'
created: 2026-10-15T11:29:55Z
norm: '1'
---

Checkpoint and restore require a disconnected workspace and drained tool calls. Keep service/Git credentials in runner memory or command environments, never under /workspace or in Git remote/config values. The full workspace archive preserves ignored and untracked files.
