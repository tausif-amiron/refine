---
name: brief
description: How a unit brief is assembled and how to read one. Use when working from .ai-sdlc/brief.md or when debugging why an agent did not have some context.
---

# Unit briefs

`orchestrator/brief.ts` assembles one brief per unit attempt. The agent never sees the whole IR.

A brief contains, in order:

1. Header: unit id, ticket, attempt number and cap.
2. SCOPE: the globs the unit may edit (enforced by the guard-files hook and again by the scope gate).
3. Order of work: tests first, then implementation, then `npm run check:full`, then commit.
4. Docs to read: sections of docs/ by path and anchor (checked by checks/guards/docs-refs.mjs).
5. IR slice: only the entities, roles, services, screens, external systems and acceptance criteria the unit
   touches; for screens, only the operations they consume.
6. Contracts the unit owns (implement exactly) and consumes (do not change), inlined.
7. owed.yaml entries addressed to the unit (deliver and close) and opened by it (waiting on).
8. On retries: the fix brief, which is the failing gate output, verbatim.

`.ai-sdlc/brief.json` carries the machine-readable part (scope, test globs, base commit, run id) for hooks.
If an agent lacked context it needed, fix the IR, the docs or brief.ts; do not paste extra context into a run.
