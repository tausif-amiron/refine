---
name: version-control
description: Branch, commit and message conventions for this workflow. Use whenever you create a branch or a commit.
---

# Version control

Source of truth: docs/CONVENTIONS.md#branches and docs/CONVENTIONS.md#commits. Summary:

- Ticket branch `feature/<TICKET>`; unit branches `feature/<TICKET>--<unit-id>` are created by the
  orchestrator. In an agent run you are already on the right branch: do not create, switch or push branches.
- Commit message: `<type>(<scope>): <summary>` with type in feat|fix|test|refactor|docs|chore|ci, summary in
  the imperative, under 72 characters. Scope = unit id in agent runs.
- Body: what and why in a few lines. Trailers, last:
  ```
  Ticket: JIRA-123
  Unit: unit-service-invoices
  Run: run-2026-11-09-0142-ab12
  ```
  (Unit and Run come from the brief.)
- Commit tests first, then implementation, when practical.
- Stage only the files you changed for this unit: `git add <paths>`, then `git commit -m "..."`.
- Never `--no-verify`, never amend commits you did not make, never push. The orchestrator merges and pushes
  after the gates pass.
