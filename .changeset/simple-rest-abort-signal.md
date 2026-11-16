---
"@refinedev/simple-rest": minor
---

feat(simple-rest): forward `meta.signal` to axios for request cancellation

`getList`, `getMany`, `getOne` and `custom` (GET only) now pass `meta.signal` to axios as the `signal` option, so in-flight requests are cancelled when the query is cancelled (for example on unmount or when filters change). Write methods do not read the signal. Behaviour is unchanged when no signal is present.
