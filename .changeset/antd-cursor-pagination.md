---
"@refinedev/antd": minor
---

feat(antd): support cursor pagination in `useTable`

With `pagination.mode: "cursor"`, `tableProps.pagination` renders only prev/next controls (no numbered page links). Next calls core `next()`, prev calls `prev()`, and each control is disabled when that direction is unavailable. The total is shown only when the data provider returns one. `useTable` and `useSimpleList` also return `next`, `prev`, `hasNextPage` and `hasPreviousPage`. Offset pagination is unchanged.
