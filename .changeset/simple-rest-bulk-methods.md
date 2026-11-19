---
"@refinedev/simple-rest": minor
---

feat(simple-rest): implement `createMany`, `updateMany` and `deleteMany`

The data provider now returns the full `Required<DataProvider>`. The three bulk methods issue one request per item in parallel (`Promise.all`), honour `meta.headers` and `meta.method` like `create`, `update` and `deleteOne`, and resolve with `{ data: [...] }` in input order. If any request fails, the call rejects with that request's error. `useCreateMany`, `useUpdateMany` and `useDeleteMany` now call them instead of falling back to per-item methods.
