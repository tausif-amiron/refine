# ADR 0001: A person approves every merge

- Status: accepted
- Date: 2026-11-09
- Ticket / PR: build plan §2.1, §9

## Context

Agents build, check, review and score each change. An autonomous merge would remove the one point where a
person reads the evidence (score, QA report, review) before code reaches production.

## Decision

Branch protection on `main` requires one approving review from a CODEOWNER and green required checks.
The review agent posts reviews with event `COMMENT` only; the posting code cannot send `APPROVE`.

## Consequences

Merge latency includes a human. Approvers read a short, consistent package (score, QA report, review).
Revisit only with measured evidence from the score and incident history.
