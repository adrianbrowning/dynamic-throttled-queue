---
dynamic-throttled-queue: patch
---

Fixed `npm install dynamic-throttled-queue` failing with `only-allow: command not found`. The published package ran the repository's `preinstall` guard in every consumer project; that script is removed.
