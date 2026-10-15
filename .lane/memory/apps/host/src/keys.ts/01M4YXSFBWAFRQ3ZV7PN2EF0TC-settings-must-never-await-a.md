---
id: 01M4YXSFBWAFRQ3ZV7PN2EF0TC
anchor: function latest
created: 2026-10-15T04:40:39Z
norm: '1'
sig: 793c9acf3835f83b
body_hash: 121631d1f094e507
raw_hash: 3ea88b80e87b6c24
lines: 127-144
---

Settings must never await a keychain read; after a prompted read only a fresh (Refresh) request reads again, or each Settings poll raises another prompt
