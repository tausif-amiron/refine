---
"@refinedev/rest": minor
---

feat(rest): forward `meta.signal` to ky for request cancellation

`getList`, `getOne`, `getMany` and `custom` (GET only) now pass `meta.signal` to ky as the `signal` option, so in-flight requests are cancelled when the query is cancelled (for example on unmount or when filters change). Write methods do not read the signal. Behaviour is unchanged when no signal is present.
