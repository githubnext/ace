---
id: 01M4ZNECSJHFG6ECVEBCBBEBJC
anchor: '@file'
created: 2026-10-15T11:34:01Z
norm: '1'
sig: e05fabb2b0d7bcbc
body_hash: d7fa00cfdff95b3d
raw_hash: 53a8bb275ef1c384
vouched: 2026-10-19T16:56:54Z
lines: 1-369
supersedes: 01M4ZN6VY85JFQK61DKGR4E8K3
---

Checkpoint and restore require a disconnected workspace and drained tool calls. Service credentials stay in runner memory; Git tokens live in /run behind a credential helper, outside /workspace and shell environments. Full workspace archives preserve ignored and untracked files, so routine env/config output must contain no token.
