---
"@refinedev/core": minor
---

feat(core): add cursor pagination to `useList` and `useTable`

`pagination.mode` accepts `"cursor"` and `pagination` accepts an optional `cursor`. In cursor mode `useList` sends the cursor to `getList` and returns the response's `cursor.next` / `cursor.prev`, and `useTable` keeps a cursor history and exposes `next()`, `prev()`, `hasNextPage` and `hasPreviousPage`. Offset modes are unchanged.
