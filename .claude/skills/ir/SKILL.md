---
name: ir
description: How to write and review the Intermediate Representation (IR) of a ticket: schema, anchoring rules, naming, questions. Use when extracting or editing ir/<TICKET>.ir.json.
---

# The IR

Full reference: docs/IR.md. Schema: ir/schema.json. Example: ir/examples/JIRA-123.ir.json.
One file per ticket, on the ticket's branch.
The repo file is canonical; the Jira ticket shows a summary.

## Sections

- `entities`: things stored. Fields with types (string, text, integer, number, boolean, date, datetime, money,
  enum + values, id, ref + ref). Mark personal data `pii: true`.
- `roles`: who acts, with permissions as verbs ("view invoices", "approve invoices").
- `screens`: what users see. `states` lists every state the ticket implies (always consider loading, empty,
  error, ready). `consumes` lists operations as "METHOD /path", which a service must expose.
- `services`: what exposes operations. `kind: legacy-wrapper` for a source with no API (page, folder, export).
  `exposes` operations with roles, request/response entity, `response_list`, `query` params. `consumes` names
  other services or external systems. `emits` events.
- `modules`: code changes that are none of the above (a utility, a CLI flag, tooling, a refactor). Each lists
  `files` it may touch (repo-relative; new or existing; this is its SCOPE), `tests`, `behaviours` (testable,
  including what must stay unchanged), optional `packages` (`{ name, dev?, version? }`, added by the
  foundation unit) and `uses` (other modules built first). Check every path against the codebase.
  Never put package.json or lockfiles in `files`: the foundation unit owns them; use `packages`.
- `external_systems`: systems outside our code, with `access` (api, page, folder, db, file) and rate limit if known.
- `limits`: volume, latency, retention, availability, with numbers.
- `unplaced`: ticket text you could not place, with the reason.
- `questions`: ambiguities. Each states `affects` (what in the product) and `if_wrong` (what goes wrong if
  answered incorrectly). A person adds `answer`.

## Anchoring

Every item's `anchor.quote` is copied exactly from the ticket (a phrase of 3+ characters that justifies it).
Code checks every quote is a substring of the ticket text. Pick the shortest phrase that clearly supports the item.

## Naming

Names are singular nouns for entities ("Invoice"), Title Case for screens ("Invoice List"), and the planner
derives folders from them (kebab-case). Reuse names that already exist in the codebase.

## Sealing

`sealed_acceptance_criteria`, `ticket_hash` and `sealed_hash` are written by code from the ticket. Editing the
criteria breaks the seal and the build refuses to run; change the ticket and re-extract instead.

## After answers

When the team answers questions, put the answer in `questions[].answer`, adjust the IR if the answer changes
it, then `npm run plan -- <TICKET>`. Unanswered questions and unplaced items block the build.
