---
paths:
  - "apps/web/**"
---

# Frontend rules

- Screens live in `apps/web/src/screens/<screen-name>/`; one folder per IR screen, kebab-case.
- Every IR screen state (`loading`, `empty`, `error`, `ready`, plus any listed in the IR) has a
  rendered branch and a test that renders it. See docs/TESTING.md#screen-units.
- Data comes only from the contracts the brief lists as consumed. Do not call an endpoint that
  is not in `contracts/openapi/`. If you need one, add an owed.yaml entry (`kind: interface`).
- Role checks use the roles in the IR slice; never hard-code a role that is not in the brief.
- No inline secrets, no `localStorage` for tokens.
