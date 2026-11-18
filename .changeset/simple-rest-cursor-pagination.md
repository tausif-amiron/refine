---
"@refinedev/simple-rest": minor
---

feat(simple-rest): support cursor pagination in `getList`

With `pagination.mode: "cursor"`, `getList` sends the cursor and page size as query params (defaults `cursor` and `limit`) instead of `_start` / `_end`, and returns `cursor.next` / `cursor.prev` read from the `x-next-cursor` / `x-prev-cursor` response headers. Pass `{ cursor: { cursorParam, limitParam, getCursor } }` as the third argument of the data provider to change them. Offset mode is unchanged.
