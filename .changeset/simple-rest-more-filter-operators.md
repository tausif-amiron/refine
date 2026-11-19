---
"@refinedev/simple-rest": minor
---

feat: support the `startswith`, `endswith` and `ncontains` filter operators. They are sent as `<field>_like` regexes (json-server 0.x). The values are regex-escaped. A second `_like` filter from these operators on the same field now throws. `in` is unchanged. `null` and `nnull` still throw the unsupported-operator error. See the operator table in the simple-rest docs.
