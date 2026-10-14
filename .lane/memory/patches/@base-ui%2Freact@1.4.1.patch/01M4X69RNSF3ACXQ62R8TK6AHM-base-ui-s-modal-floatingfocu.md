---
id: 01M4X69RNSF3ACXQ62R8TK6AHM
anchor: '@file'
created: 2026-10-14T12:30:52Z
norm: '1'
sig: ad1ec40ada24dcbf
body_hash: 34ab3a9a3780676a
raw_hash: 60eb1832348dc725
lines: 1-44
---

Base UI's modal FloatingFocusManager moves focus off its inside focus guards with enqueueFocus on the next animation frame, and only aria-hides the page behind the dialog. A Tab arriving before that frame (fast key repeat, a busy main thread, CDP key events) moved focus from the guard to the app behind the dialog (#172). The patch makes those two modal redirects synchronous. Upstream 1.8.0 still uses the frame-delayed redirect; re-check before dropping the patch on upgrade.
