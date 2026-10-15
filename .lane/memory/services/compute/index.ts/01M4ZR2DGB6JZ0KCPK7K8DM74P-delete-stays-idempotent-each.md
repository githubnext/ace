---
id: 01M4ZR2DGB6JZ0KCPK7K8DM74P
anchor: class Compute
created: 2026-10-15T12:19:54Z
norm: '1'
sig: 3b062341dbce15d0
body_hash: d07e20bc0582f189
raw_hash: 99147994bd2de0d4
lines: 51-353
---

DELETE stays idempotent: each step tolerates a prior partial attempt, and controller storage is cleared last so a failed channel delete can be retried
