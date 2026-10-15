---
id: 01M4YSA7B2JKQ12MX3B6DA66G1
anchor: const MIGRATIONS
created: 2026-10-15T03:22:24Z
norm: '1'
sig: 106ab0bf742bac08
body_hash: 22e53bc349d0c6f1
raw_hash: 7a63f5f5162b5252
lines: 18-25
---

Durable Object SQLite refuses PRAGMA user_version, so the schema version lives in the kv `version` key; never edit a shipped migration
