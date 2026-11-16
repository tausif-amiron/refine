---
"@refinedev/simple-rest": patch
---

fix: unsupported filter operators (for example `gt`, `lt`, `nin`, `between`) no longer silently become equality filters. `generateFilter` now throws a descriptive `operator: <operator> is not supported` error for them. `eq`, `in`, `ne`, `gte`, `lte` and `contains` are unchanged, and the `q` field stays exempt.
