<!-- ai-sdlc:start -->

# Testing

Code decides pass or fail. This file says which checks run for which unit, and what counts as a test.

## Check levels

| Level       | When                                                                    | Runs                                                                                                            |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| fast        | after every Edit/Write (PostToolUse hook)                               | `checks.fast` in `ai-sdlc.config.json` (type check, lint)                                                       |
| changed     | agents, while working (`run-checks.mjs changed`)                        | `checks.fast` plus only the tests changed since the brief's base commit                                         |
| full        | when an agent stops (Stop hook) and after every unit run (orchestrator) | `checks.full` (type check, lint, tests, build, guards)                                                          |
| unit gates  | orchestrator, per unit                                                  | scope diff, tests changed, no new lint errors (`checks.lintChanged`), seen-red, owed.yaml, mutation fast subset |
| integration | orchestrator QA phase, simulator running                                | `checks.integration`, `checks.contract`                                                                         |
| pre-push    | before the PR is opened                                                 | mutation full catalogue                                                                                         |
| CI gates    | every PR                                                                | tests, build, SAST (CodeQL), secret scan (gitleaks), guards, IR drift                                           |

Every run of `checks/hooks/run-checks.mjs <level>` writes its full output to `.ai-sdlc/checks/<level>.log` and prints
a short summary (each command, result, time; for a failure the last lines and the log path), so an agent can act on a
long run even when Claude Code moves it to the background.

## Unit types

### foundation-units

Project wiring: config, auth middleware, logger, error types. Tests cover auth deny-by-default and error mapping.

### data-model-units

Entity types, validation, migration up and down. Tests: validation rules from the IR, migration round trip.

### service-units

Endpoints from `contracts/openapi/<service>.yaml`. Tests: one per operation for success, each documented
error status, role denial for each role not permitted. Contract test: responses validate against the schema.

### legacy-wrapper-units

Service over a no-API source. Tests: parsing against fixtures recorded from the simulator, retry with
backoff, idempotent write (same record twice → one row), dead-letter on unparseable input, contract test.

### screen-units

Tests render every IR state (`loading`, `empty`, `error`, `ready`, plus IR-listed states) and each role
variant. Data is mocked from the consumed contract's examples, never invented.

### module-units

A code change that is not an entity, screen or service (a utility, a CLI flag, tooling). The unit may touch
only the files its IR module lists. Tests: one or more per behaviour, including the behaviours that must stay
unchanged, with cases on both sides of every threshold so boundary mutations (`<` to `<=`) are caught. Package
manifests and lockfiles are configuration: changing them needs no test, and they are never mutated.

### wiring-units

The wiring unit registers every new screen and service in the shared files (routes, nav, app/router
registration). Its tests prove each listed unit is reachable: the route resolves to the screen, nav shows it to
the right roles, the service router is mounted at the contract's paths.

### walk-units

End-to-end specs (Playwright): UI walk as a new user through the UI only; API walk from contracts only.
A ticket with no UI or API (a command-line tool, a library, tooling) is walked through its real entry point: the
specs run the real command (e.g. as a subprocess) on the repo's fixtures and check output and exit status, so the
walk keeps running with the suite. Walk specs live in the stack profile's walk folder (`scope.walk`; Python:
`tests/walk/`). When `checks.integration` is empty, QA runs only the contract check and says so in its report.

## contract-tests

Both sides test against the contract, never against each other's code. Helpers in
`tools/ai-sdlc/checks/contract/index.mjs` (the workflow folder: `tools/ai-sdlc` when installed):

- Provider tests: `assertResponse("contracts/openapi/<svc>.yaml", "GET", "/invoices/42", 200, body)` checks the
  status is documented and the body matches its schema. `assertRequest(...)` checks request bodies.
- Consumer tests: `exampleFor("contracts/openapi/<svc>.yaml", "GET", "/invoices")` returns a deterministic body
  that matches the schema; mock with it instead of inventing data.
- Static check (QA phase and CI): `node tools/ai-sdlc/checks/contract/verify.mjs` fails if an operation in a contract
  has no matching route in its owner's folder, or a route in that folder is not in the contract.

## seen-red

A test that has never been seen red does not count. A test the unit added counts once it has failed at least
once, in either of two ways (seen-red is decided after the mutation gate runs):

1. **Red at base.** Each unit's implementation files are reverted to the commit the brief was issued at,
   and the unit's tests run. Every test must fail. Tests that pass without the implementation are reported
   as `never-red` and fail the unit. Tests that already existed at the base commit (in a test file the unit
   extended) are not required to be red: the base versions of those files are run first to learn which.
2. **Mutation.** Deliberate breakages in the unit's changed lines (and the catalogue) must each turn at
   least one test red. A test that pins behaviour the ticket says must stay unchanged passes at base by
   design; it is seen red when a mutant breaks that behaviour.

**Pins.** When no mutant can reach such a test, name it as a pin (`test_pin_...` in Python, `"pin: ..."` in
JavaScript; `tests.pinPattern` overrides). A pin is held to the opposite rule: it must pass without the
implementation and with it, which proves the behaviour did not change. A pin that fails without the change is
rejected as mislabelled, and a unit that changed its implementation still needs at least one non-pin test seen red. Survivors are reported. Tests that go red under mutation are added to the ledger
`.ai-sdlc/seen-red.json`.

## mutation-catalogue

`checks/mutation/catalogue.yaml` lists hand-written breakages that matter for this product (e.g. removing
an auth check, dropping an audit log call). Each entry: `id`, `file` (glob), `find`, `replace`, optional
`note`. Generic operators (comparison flips, boolean flips, return removal, boundary shifts) apply
automatically to changed lines. The fast subset (first N in a deterministic order) runs per unit; the full
catalogue runs before the PR.

When none of those operators applies to a unit's changed lines (declarative code: a flag, a route, a config
value), a second tier of **literal** mutants is used instead: emptied strings, dropped template or f-string
expressions, emptied keyword or property values. The PR says which tier ran, or that the change was not tested by
mutation at all.

**A repo's own mutation tool** can be a gate too (`mutation.external` in `ai-sdlc.config.json`): when a unit adds
entries to that tool's catalogue, the tool runs on exactly those entries, and each must be caught. Example:
`{ "catalogue": "tools/mutations.toml", "idPattern": "^id\\s*=\\s*\"([^\"]+)\"", "command": "uv run python tools/mutate.py --only {id}" }`.

## Flaky vs failed

The QA agent re-runs a failing test up to 2 more times. Passes on retry → `flaky` (reported, does not
block, ticket opened against the test). Fails every time → `failed` (fix brief to the owning unit).

<!-- ai-sdlc:end -->
