---
"@refinedev/simple-rest": patch
---

fix(simple-rest): read `getList` total from `x-total-count` explicitly

`x-total-count: 0` is now returned as `total: 0` instead of falling back to `data.length`. When the header is missing, empty, non-numeric, negative or not finite, `total` falls back to `data.length`; this fallback is now handled explicitly and documented.
