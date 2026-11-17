<!-- ai-sdlc:start -->

# The IR (Intermediate Representation)

The IR is the structured, checkable version of one ticket. Everything after extraction works from it:
the planner cuts it into units, each unit's brief gets a slice of it, contracts are generated from it,
and the blind score is measured against the acceptance criteria sealed inside it.

- **One file per ticket:** `ir/<TICKET>.ir.json`, committed on the ticket's branch (`feature/<TICKET>`).
- **The repo file is canonical.** The Jira ticket gets a summary comment; the build reads only the file.
- **Formal schema:** `ir/schema.json` (JSON Schema 2020-12). This document explains it; the schema decides.
- **Worked example:** `ir/examples/JIRA-123.ticket.md` (the ticket) and `ir/examples/JIRA-123.ir.json` (its IR).

## How an IR is made

```
ticket (Jira, or a file)
  │  1. fetched by code: text = "# <summary>\n\n<description>"
  │  2. code parses the numbered acceptance criteria from the ticket text
  ▼
extract agent (read-only: Read, Grep, Glob)
  │  3. reads the ticket and the codebase, returns IR JSON
  ▼
code
  │  4. overwrites the sealed fields (criteria, ticket_hash, sealed_hash)
  │  5. validates: schema, anchors, references        → on failure, one retry with the errors
  │  6. writes ir/<TICKET>.ir.json and ir/<TICKET>.probes.json, commits on feature/<TICKET>
  │  7. posts the summary and open questions to Jira
  ▼
a person answers questions (questions[].answer) and places unplaced text
  ▼
npm run plan -- <TICKET>      → units + contracts (refuses while anything is open)
```

Commands: `npm run extract -- <TICKET>` (or `--ticket-file <path>` offline), `/ir <TICKET>` to review
and answer interactively, `npm run plan -- <TICKET>` when nothing is open.

**What the model writes and what code writes.** The extract agent writes the product facts: entities,
roles, screens, services, external systems, limits, unplaced text, questions. Code writes
`schema`, `ticket`, `sealed_acceptance_criteria`, `ticket_hash` and `sealed_hash`. The agent cannot
change the bar the work is measured against; whatever it puts in those fields is replaced.

## What the ticket must look like

Extraction only works on tickets in the ticket skill's format (`.claude/skills/ticket/SKILL.md`).
The part code depends on is the acceptance criteria:

- A heading named `Acceptance criteria` (markdown `##`, Jira `h2.`, or a bare `Acceptance criteria:` line).
  The heading text is configurable: `jira.acceptanceCriteriaHeading` in `ai-sdlc.config.json`.
- Numbered items under it, in any of these forms: `1. text`, `1) text`, `AC-1: text`, `AC1. text`, `- AC-1 text`.
- A line that is not a new item continues the previous one (wrapped lines are joined).
- `-` bullets under an item belong to it (for example the cases it must cover) and are kept as list lines in the
  sealed text.
- Items become `AC-1`, `AC-2`, … in order. If the ticket's numbers repeat, they are renumbered.

A ticket with no numbered criteria is rejected before the agent runs.

## File layout

All top-level fields are required. Unknown fields are rejected (`additionalProperties: false`
everywhere). Files are written with keys sorted, so the same IR is always byte-identical.

| Field                        | Type                              | Written by                               | Meaning                                                                         |
| ---------------------------- | --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| `schema`                     | `"ai-sdlc.ir.v1"`                 | code                                     | format version                                                                  |
| `ticket`                     | string, `^[A-Z][A-Z0-9]+-[0-9]+$` | code                                     | ticket key, e.g. `JIRA-123`                                                     |
| `title`                      | string                            | agent (falls back to the ticket summary) | one-line title                                                                  |
| `ticket_hash`                | `sha256:<64 hex>`                 | code                                     | hash of the ticket text at extraction; CI compares it to the live ticket        |
| `sealed_hash`                | `sha256:<64 hex>`                 | code                                     | hash of `sealed_acceptance_criteria`; the build refuses if they no longer match |
| `sealed_acceptance_criteria` | `[{ id, text }]`, at least 1      | code                                     | the bar; copied from the ticket                                                 |
| `entities`                   | array                             | agent                                    | things the product stores                                                       |
| `roles`                      | array                             | agent                                    | who acts, and what they may do                                                  |
| `screens`                    | array                             | agent                                    | what users see                                                                  |
| `services`                   | array                             | agent                                    | what exposes operations (HTTP endpoints)                                        |
| `external_systems`           | array                             | agent                                    | systems outside the codebase                                                    |
| `limits`                     | array                             | agent                                    | non-functional limits, as numbers                                               |
| `modules`                    | array, **optional**               | agent                                    | code changes that are not entities, screens or services                         |
| `unplaced`                   | array                             | agent                                    | ticket text that fits nowhere above                                             |
| `questions`                  | array                             | agent asks, a person answers             | ambiguities that change what gets built                                         |

Arrays may be empty, but must be present (except `modules`, which may be left out).

## Names

Entity, role, screen, service and external-system names match `^[A-Za-z][A-Za-z0-9 _-]*$` and are unique
within their section (case-insensitive). The planner turns them into folders and ids in kebab-case:

| IR name                                   | Unit id                       | Folder (default scope template)         |
| ----------------------------------------- | ----------------------------- | --------------------------------------- |
| entity `Invoice`                          | `unit-data-invoice`           | `apps/api/src/models/invoice/`          |
| service `Invoices`                        | `unit-service-invoices`       | `apps/api/src/services/invoices/`       |
| service `Invoice Import` (legacy-wrapper) | `unit-wrapper-invoice-import` | `apps/api/src/wrappers/invoice-import/` |
| screen `Invoice List`                     | `unit-screen-invoice-list`    | `apps/web/src/screens/invoice-list/`    |

Conventions: entities are singular nouns (`Invoice`), screens are Title Case (`Invoice List`), and names
already used in the codebase are reused rather than invented.

## Anchors

Every entity, role, screen, service, external system and limit carries an anchor:

```json
"anchor": { "quote": "invoice number, amount, due date and status", "section": "Acceptance criteria" }
```

- `quote` (required, at least 3 characters) is text **copied from the ticket**. `section` is optional.
- Code checks every quote is a substring of the ticket text, after normalising both sides: curly quotes
  become straight, en/em dashes become `-`, the characters `` * _ ` # > `` are removed, whitespace collapses
  to single spaces, and comparison ignores case. A paraphrase fails validation.
- Pick the shortest phrase that clearly justifies the item. Anchors are how a reviewer checks that the agent
  did not invent a requirement.

Operations inside a service, fields inside an entity, and questions have no anchors of their own.

## Sections

### `entities`: what is stored

| Field    | Required | Rules                                                                           |
| -------- | -------- | ------------------------------------------------------------------------------- |
| `name`   | yes      | see Names                                                                       |
| `fields` | yes      | list (may be empty); do not include `id`, which every entity gets automatically |
| `anchor` | yes      | see Anchors                                                                     |

Each field:

| Field      | Required   | Rules                                                                                              |
| ---------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `name`     | yes        | `^[a-z][a-z0-9_]*$` (snake_case)                                                                   |
| `type`     | yes        | `string`, `text`, `integer`, `number`, `boolean`, `date`, `datetime`, `money`, `enum`, `id`, `ref` |
| `required` | no         | `true` makes the column non-null and the property required in contracts                            |
| `pii`      | no         | `true` marks personal data: never logged, flagged `x-pii` in contracts                             |
| `values`   | for `enum` | non-empty list of allowed values                                                                   |
| `ref`      | for `ref`  | name of another entity in this IR                                                                  |

How types become contracts:

| IR type                | OpenAPI / JSON Schema                                               | DB column                           |
| ---------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| `string`, `text`, `id` | `string`                                                            | `text`                              |
| `integer`              | `integer`                                                           | `integer`                           |
| `number`               | `number`                                                            | `double precision`                  |
| `money`                | `string`, pattern `^-?[0-9]+(\.[0-9]{1,2})?$` (decimal as a string) | `numeric(18,2)`                     |
| `boolean`              | `boolean`                                                           | `boolean`                           |
| `date` / `datetime`    | `string`, format `date` / `date-time`                               | `date` / `timestamptz`              |
| `enum`                 | `string` with `enum`                                                | `text` with `check_values`          |
| `ref`                  | `string` (id of the referenced entity)                              | `text` with `references <table>.id` |

Every table also gets `id`, `created_at` and `updated_at`.

### `roles`: who acts

| Field         | Required | Rules                                                |
| ------------- | -------- | ---------------------------------------------------- |
| `name`        | yes      | see Names                                            |
| `permissions` | yes      | plain verbs: `"view invoices"`, `"approve invoices"` |
| `anchor`      | yes      |                                                      |

Every role named by a screen or an operation must be defined here. Code denies by default: an operation's
`roles` is the complete list of who may call it.

### `screens`: what users see

| Field      | Required | Rules                                                                                                                                    |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | yes      | see Names                                                                                                                                |
| `states`   | yes      | every state the ticket implies. Always consider `loading`, `empty`, `error`, `ready`; add others the ticket describes (e.g. `approving`) |
| `roles`    | no       | roles that can open the screen                                                                                                           |
| `consumes` | yes      | operations the screen calls, written `"METHOD /path"` exactly as a service exposes them, e.g. `"GET /invoices/:id"`                      |
| `anchor`   | yes      |                                                                                                                                          |

Each state becomes a required test in the screen unit (docs/TESTING.md#screen-units).

### `services`: what exposes operations

| Field      | Required | Rules                                                                                               |
| ---------- | -------- | --------------------------------------------------------------------------------------------------- |
| `name`     | yes      | see Names                                                                                           |
| `kind`     | yes      | `service`, or `legacy-wrapper` for a source with no API (a page to scrape, a file export, a folder) |
| `entities` | no       | entities this service reads or writes                                                               |
| `exposes`  | yes      | operations (below)                                                                                  |
| `consumes` | no       | names of other services or external systems this one calls                                          |
| `emits`    | no       | events: `{ name, entity? }`; `name` matches `^[a-z][a-z0-9_.]*$`, e.g. `invoice.approved`           |
| `anchor`   | yes      |                                                                                                     |

Each operation in `exposes`:

| Field             | Required | Rules                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------- |
| `method`          | yes      | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`                                   |
| `path`            | yes      | starts with `/`; path parameters as `:name` (becomes `{name}` in OpenAPI) |
| `summary`         | no       | one line                                                                  |
| `roles`           | no       | roles allowed to call it; everyone else gets 403                          |
| `request_entity`  | no       | entity sent as the body                                                   |
| `response_entity` | no       | entity returned                                                           |
| `response_list`   | no       | `true` returns an array of `response_entity`                              |
| `query`           | no       | query parameter names, e.g. `["vendor", "status"]`                        |

`METHOD /path` must be unique across all services: one operation, one owner. Success codes in the generated
contract: `GET`/`PUT`/`PATCH` 200, `POST` 201, `DELETE` 204; every operation also documents 400, 401, 403,
and 404 when the path has a parameter.

### `external_systems`: systems outside the codebase

| Field        | Required | Rules                                                                                  |
| ------------ | -------- | -------------------------------------------------------------------------------------- |
| `name`       | yes      | see Names                                                                              |
| `access`     | yes      | `api`, `page`, `folder`, `db`, `file`                                                  |
| `rate_limit` | no       | as stated by the system's owner, e.g. `"60 requests/minute"`, `"one export per night"` |
| `anchor`     | yes      |                                                                                        |

A service lists external systems it uses in `consumes`.

### `limits`: non-functional limits

| Field    | Required | Rules                                                                             |
| -------- | -------- | --------------------------------------------------------------------------------- |
| `kind`   | yes      | `volume`, `latency`, `retention`, `availability`, `other`                         |
| `value`  | yes      | a number with units: `"500 invoices in under 2 s"`, `"by 06:00 the next morning"` |
| `anchor` | yes      |                                                                                   |

Limits go to the foundation and walk units' briefs.

### `modules`: code changes that are not product shapes

For work that is not stored data, a screen or an HTTP service: a utility function, a CLI flag, a build or
test-tool setup, a refactor. Each module becomes one unit whose SCOPE is **exactly** its files and tests.

| Field        | Required        | Rules                                                                                                                                                                                                            |
| ------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | yes             | see Names; becomes `unit-module-<name>`                                                                                                                                                                          |
| `files`      | yes, at least 1 | every file the change may touch, new or existing, repo-relative (no leading `/`, no `..`); globs allowed. Never `package.json` or a lockfile: list dependencies in `packages`, and the foundation unit adds them |
| `tests`      | yes, at least 1 | test files that prove the behaviours, new or existing; not also listed in `files`                                                                                                                                |
| `behaviours` | yes, at least 1 | testable statements, including what must stay unchanged                                                                                                                                                          |
| `packages`   | no              | `{ name, dev?, version? }`: packages the change needs. The foundation unit adds them (it owns package.json and lockfiles); a hook lets it install only these                                                     |
| `uses`       | no              | other modules this one depends on; they are built first                                                                                                                                                          |
| `anchor`     | yes             | see Anchors                                                                                                                                                                                                      |

```json
{
  "name": "Relative Time",
  "files": ["src/utils/relativeTime.ts", "src/pages/EmployeeProfile.tsx"],
  "tests": ["src/utils/relativeTime.test.ts"],
  "behaviours": [
    "7 to 29 days returns 'N week(s) ago', N = days / 7 rounded down",
    "under 7 days, minutes, hours and 30 days or more are unchanged"
  ],
  "packages": [{ "name": "vitest", "dev": true }],
  "anchor": { "quote": "For ages from 7 to 29 days" }
}
```

Rules checked by code: no package manifest or lockfile in `files`; names are unique; `uses` names existing modules and has no cycles; a file belongs to
one module only, and is not also a test; at planning, no module file may fall inside another unit's SCOPE.

### `unplaced`: what did not fit

```json
{
  "text": "Exports should look like the old ones",
  "reason": "no design or sample given; cannot be placed or tested"
}
```

Ticket text the agent could not place in any section above, with the reason. **Any unplaced item blocks the
build.** A person resolves it: by changing the ticket and re-extracting, or by removing it from the IR with
the reason recorded in the commit.

### `questions`: ambiguities

| Field      | Required | Rules                                         |
| ---------- | -------- | --------------------------------------------- |
| `q`        | yes      | the question, at least 5 characters           |
| `affects`  | yes      | what in the product depends on the answer     |
| `if_wrong` | yes      | what goes wrong if it is answered incorrectly |
| `answer`   | no       | written by a person                           |

```json
{
  "q": "Is the invoice 'line total' the same as the invoice amount, or a sum of line items we do not import yet?",
  "affects": "Invoice Detail screen and the Invoice entity (whether line items are stored)",
  "if_wrong": "The detail screen shows the wrong figure, or we build line-item storage nobody needs",
  "answer": "Same as amount; no line items in this ticket."
}
```

**Any question without an `answer` blocks the build.** If an answer changes the facts, edit the affected
sections too, then re-plan.

### `sealed_acceptance_criteria`: the bar

```json
[
  {
    "id": "AC-1",
    "text": "An accounts clerk can see a list of invoices with vendor name, ..."
  }
]
```

Written by code from the ticket; never edited by hand. If the criteria must change, change the ticket and
re-extract. They drive three things: the probe sheet for the blind score (`ir/<TICKET>.probes.json`, one
probe per criterion), the criteria each unit's brief shows, and the "did it do what was asked?" table in the
review agent's comment.

## What validation checks

`validateIr()` in `orchestrator/ir.ts` runs at extraction, at planning and at the start of every build.
An IR is valid only when all of these hold:

1. **Schema:** `ir/schema.json` passes (required fields, types, patterns, no unknown fields).
2. **Anchors:** every anchor quote is found in the ticket text (at extraction, when the text is available).
3. **Seal:** `sealed_hash` equals the hash of `sealed_acceptance_criteria`.
4. **Unique names** within entities, screens, services and roles (case-insensitive).
5. **References resolve:**
   - a service's `entities`, `request_entity` and `response_entity` name existing entities;
   - a service's `consumes` names an existing service or external system;
   - every role on an operation or a screen exists in `roles`;
   - every operation a screen `consumes` is exposed by some service;
   - no `METHOD /path` is exposed by two services;
   - every `ref` field names an existing entity, and every `enum` field has `values`;
   - every module's `uses` names an existing module, without cycles; no file belongs to two modules or is both
     a file and a test.

Before building, two more conditions must hold: no unanswered questions, and no unplaced items.

## From IR to units

`npm run plan -- <TICKET>` is deterministic: the same IR always gives the same units and contract files.

| IR                                   | Unit                                                                                                                             | Contracts it owns                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| (always)                             | `unit-foundation`: config, auth, logging, error types, package.json and lockfiles; adds every package `modules[].packages` lists | —                                                                |
| each entity                          | `unit-data-<entity>`, after foundation and any entity it references                                                              | `contracts/db/<entity>.json`                                     |
| each service                         | `unit-service-<name>` or `unit-wrapper-<name>`, after its entities and the services it consumes                                  | `contracts/openapi/<name>.yaml`, `contracts/events/<event>.json` |
| each screen                          | `unit-screen-<name>`, after the services whose operations it consumes                                                            | — (consumes the services' OpenAPI)                               |
| each module                          | `unit-module-<name>`, after foundation and the modules it `uses`; SCOPE = its files and tests                                    | —                                                                |
| (when there are screens or services) | `unit-wiring`: routes, nav, app and router registration, after every screen and service                                          | —                                                                |
| (always)                             | `unit-walk`: the QA agent's end-to-end walk, last                                                                                | —                                                                |

The planner's own check confirms every screen, entity and endpoint is planned exactly once. Each unit's brief
then gets only its slice of the IR: its own entities, services and screens (a screen sees only the operations it
consumes), the roles they mention, the criteria that name them, and answered questions.

## Writing a good IR: checklist

- [ ] Every item has an anchor quoted word for word from the ticket.
- [ ] Every screen lists all its states, including empty and error.
- [ ] Every operation a screen needs is exposed by exactly one service, written identically on both sides.
- [ ] Every operation lists its roles; every role is defined.
- [ ] Personal data fields are marked `pii`.
- [ ] Limits are numbers, not adjectives.
- [ ] Ambiguities are questions with `affects` and `if_wrong`, not guesses.
- [ ] Nothing is invented: anything not in the ticket is a question or is left out.
- [ ] Code-only work is a module with real paths, not a made-up screen or service.
- [ ] Existing names in the codebase are reused.

## Editing after extraction

| You want to                            | Do this                                                                                                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| answer a question                      | write `questions[].answer`, adjust sections if the answer changes them, commit, re-plan                                                                                                                                            |
| fix a wrong entity, screen or service  | edit the IR, commit, re-plan. A passed unit stays passed only if its fingerprint (its definition and the IR slice its brief shows, answers included) is unchanged and every unit it depends on stayed passed; the rest build again |
| change the acceptance criteria         | change the ticket, then re-extract. Editing them in the file breaks the seal and the build refuses                                                                                                                                 |
| check the ticket has not changed since | CI does this (`checks/guards/ir-drift.ts`): the live ticket's hash must equal `ticket_hash`                                                                                                                                        |

## Choosing the section

| The ticket asks for                        | Section                                                      |
| ------------------------------------------ | ------------------------------------------------------------ |
| something stored, with fields              | `entities`                                                   |
| who may do what                            | `roles`                                                      |
| a page or view users see                   | `screens`                                                    |
| an HTTP endpoint                           | `services` (`kind: legacy-wrapper` for a source with no API) |
| a utility, a CLI flag, tooling, a refactor | `modules`                                                    |
| a non-functional limit                     | `limits`                                                     |
| none of these                              | `unplaced`, with the reason                                  |

<!-- ai-sdlc:end -->
