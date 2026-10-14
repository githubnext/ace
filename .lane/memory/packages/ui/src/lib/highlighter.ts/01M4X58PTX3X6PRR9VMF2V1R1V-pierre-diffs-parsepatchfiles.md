---
id: 01M4X58PTX3X6PRR9VMF2V1R1V
anchor: function patchFile
created: 2026-10-14T12:12:49Z
norm: '1'
sig: 6fb5209c1a2a5aff
body_hash: 8345408fd2d82301
raw_hash: f34af7a5c95b81c3
lines: 383-389
---

@pierre/diffs parsePatchFiles silently drops text after the last hunk (even with throwOnError, non-+/-/space lines just end the hunk) and getSingularPatch throws on multi-file patches; patchFile's line-count walk is what keeps mixed tool output from losing text (#102).
