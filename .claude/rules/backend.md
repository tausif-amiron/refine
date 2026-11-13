---
paths:
  - "apps/api/**"
---

# Backend rules

- Every route is registered with an auth middleware (`requireAuth`) or carries a `// @public`
  comment with a reason. The guard `checks/guards/auth-endpoints.mjs` enforces this.
- Every write (insert/update/delete) is logged with the audit logger. See docs/CONVENTIONS.md#logging.
- Implement exactly the contract in `contracts/openapi/<service>.yaml`; status codes and error
  bodies follow docs/CONVENTIONS.md#errors.
- Migrations are reversible: every `up` has a `down`, checked by `npm run test:migrations`.
- Legacy wrappers (sources with no API): poll with backoff, idempotent writes keyed by source id,
  dead-letter path for records that fail parsing, contract test against the simulator.
  Rate limits for the source are recorded in docs/ARCHITECTURE.md; never exceed them.
