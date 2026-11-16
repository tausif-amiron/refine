# ai-sdlc

The ticket-to-production workflow from `docs/AI-Augmented SDLC_ Build Plan with Claude Code.md`, built on
Claude Code. **A model does the work, code decides pass or fail, a person approves.**

```
Jira ticket → extract (IR, sealed criteria) → plan (units + contracts) → dev agents in worktrees
  → gates (scope · checks · tests changed · seen-red · mutation · owed.yaml) → 3 attempts, then 1 on a stronger model (escalationModel), then escalate to a person
  → QA (integration + walk, fix briefs) → blind score → PR → review agent (comments only) → CI gates
  → human approval → release (notes, staged rollout, watch) → ops (dedup ticket, verify fix)
```

## Quick start

```bash
npm ci
npm test                         # unit tests + the end-to-end loop with a scripted agent (~1 min)
npm run check:claude-version     # installed Claude Code must match .claude-code-version
```

Install into a client repository (then review and commit what it wrote):

```bash
node scripts/install.mjs ../client-app            # first install → tools/ai-sdlc/, .claude/, docs, config, workflows
node scripts/install.mjs ../client-app --update   # later: replace workflow-owned files only
```

It prints what it wrote and what to check (missing npm scripts, scope templates vs your layout, CODEOWNERS,
how QA starts your app). In the client repo every stage is `npm run ai-sdlc -- <command> <TICKET>`.

Per ticket (in the client repository; `npm run ai-sdlc -- <command>` there, `npm run <command>` here):

| Step | Command | Gate (code) |
| --- | --- | --- |
| Write the ticket | `/ticket <description>` | checklist in the ticket skill |
| Extract the IR | `npm run extract -- JIRA-123` | schema, every anchor quotes the ticket, references resolve, criteria sealed from the ticket text |
| Answer questions | `/ir JIRA-123` | build refuses while questions are unanswered |
| Plan | `npm run plan -- JIRA-123` | deterministic; every screen/endpoint/entity planned exactly once |
| Build + QA | `npm run build-ticket -- JIRA-123` | Stage 1 contracts gate, unit gates, 3-attempt cap, budget cap; wiring unit registers routes/nav last; QA starts the simulator and app, runs contract + integration checks and the walk |
| Score | `npm run score:probe -- JIRA-123` (starts the app; or `--url <running build>`) then `npm run score:finalize -- JIRA-123` | probes match the sealed bar; unreached = difference |
| PR | `npm run pr -- JIRA-123` | all units passed, QA passed, no open owed entries |
| Review | CI (`review.yml`) | posts `COMMENT` only |
| Merge | a person approves | branch protection (`scripts/branch-protection.sh`) |
| Release | CI (`release.yml`) | staged rollout, health checks, auto rollback, watch window |
| Incidents | CI (`ops.yml`) on alert | fingerprint dedup, rate limit, pre-approved actions only, verify window |
| Learning loop | `npm run learn` | repeated human corrections the agent missed → convention proposals |
| Dashboard | `npm run report`, `npm run dashboard` | cost and cycle time per ticket |

Offline extraction (no Jira): `npm run extract -- JIRA-123 --ticket-file path/to/ticket.md`.

## Where each part of the build plan lives

The client-repo GitHub workflows (`gates`, `review`, `release`, `ops`) are templates in `templates/github-workflows/`;
the installer writes them to the client's `.github/workflows/`. This repo's own `.github/workflows/` holds only
`ci.yml` (typecheck and tests for the workflow itself), so nothing here deploys, reviews or pages anyone.


| Plan § | Component | Files |
| --- | --- | --- |
| 5.1 | Repo documents | `CLAUDE.md`, `docs/*.md`, `.claude/rules/`, `docs/adr/` |
| 5.2 | Ticket skill | `.claude/skills/ticket/`, `.claude/commands/ticket.md` |
| 5.3 | Extract → IR | `.claude/agents/extract.md`, `orchestrator/extract.ts`, `orchestrator/ir.ts`, `ir/schema.json` |
| 5.4 | Planner + contracts | `orchestrator/plan.ts` |
| 5.5 | Tests first | brief order of work, Stop hook, `tests-changed` and `seen-red` gates |
| 5.6 | Dev agents + owed.yaml | `.claude/agents/dev-*.md` (frontend, backend, wiring), `orchestrator/{run,brief,owed,attempts,git,runner}.ts`, hooks |
| 5.7 | Checks, mutation, contracts, QA | `orchestrator/gates.ts`, `checks/mutation/`, `checks/contract/`, `checks/guards/`, `orchestrator/{qa,services}.ts` |
| 5.8 | Blind score | `orchestrator/score.ts`, `.claude/agents/score.md`, `/score` |
| 5.9 | Telemetry | `orchestrator/telemetry.ts`, `checks/hooks/{tool-telemetry,stop}.mjs`, `scripts/report.ts` |
| 5.10 | Review agent | `orchestrator/review.ts`, `.claude/agents/review.md`, `templates/github-workflows/review.yml` |
| 5.11 | Approval + merge pipeline | `templates/github-workflows/{gates,release}.yml`, `orchestrator/release.ts`, `scripts/branch-protection.sh` |
| 5.12 | Ops loop | `orchestrator/ops.ts`, `.claude/agents/ops.md`, `templates/github-workflows/ops.yml` |
| Phase 3 | Install into client repos | `scripts/install.mjs`, `bin/ai-sdlc.mjs`; plugin manifest `.claude-plugin/plugin.json` for interactive use only (headless runs need the agents in the repo, which the installer provides) |
| — | Simulator | `simulator/server.mjs` (`npm run simulator`) |

## What is enforced by code (and tested)

- Agents edit only their SCOPE (`guard-files` hook before the edit, `scope` gate on the diff after).
- Agents cannot touch `.env*`/`secrets/`, their own hooks, CI, contracts or the IR; cannot push, use `gh`, or skip verification.
- A unit cannot pass if implementation changed without tests, if any test passes without the implementation
  (red at base), if a mutant of its changed lines survives, or while an owed entry addressed to it is open.
- A consumer that opens an owed entry is held; the provider is re-opened, delivers, closes; the consumer wakes.
  New packages go to the foundation unit (`dependency`); routes and nav go to the wiring unit (`wiring`, non-blocking).
- Contracts are checked both ways: helpers validate provider responses and generate consumer mocks from the
  schema; `checks/contract/verify.mjs` fails on operations without a route and routes without an operation.
- QA and the score start the simulator and the app, wait for health, and always stop them.
- Unit worktrees get every `node_modules` folder linked (root and per app), never committed, never deleted.
- Three failed attempts → escalation report (+ Jira comment); dependents are not started. Ticket budget cap.
- The acceptance criteria are copied from the ticket by code and hashed; changing them breaks the build and the score.
- The review poster hard-codes `event: COMMENT`; model output asking to approve is ignored.
- One alert storm → one ticket; recurrences after a fix reopen it; verification closes it after a quiet window.

`tests/loop.e2e.test.ts` runs the real loop (git worktrees, real vitest, real gates) with a scripted agent and
shows each of these on a small ticket, including a deliberately failing unit that escalates.

## Setting it up for a team

1. **Claude Code**: install the pinned version (`.claude-code-version`). Agents run headless as
   `claude -p --agent <name> --permission-mode dontAsk --output-format json --max-budget-usd <n>`
   (`orchestrator/runner.ts`); set `AI_SDLC_RUNNER=sdk` to use the Agent SDK instead.
2. **Client repo**: `node scripts/install.mjs <repo>`. Then in `ai-sdlc.config.json`: scope templates for your
   layout (including `wiring`), the `app` service (`APP_START_COMMAND`, `APP_URL`), check commands. Add a
   `## Client system` section to `docs/ARCHITECTURE.md` and draft `CONVENTIONS.md` from the code (plan §5.1).
3. **Jira**: statuses "In Progress" (the ready status), "Needs answers", "Fix deployed", and the statuses the
   pipeline moves tickets to: "Blocked", "In Review", "Done" (names in config, `jira.stages`; a status your
   workflow lacks is skipped). Separate credentials for read (extract, CI drift check) and write (ops, ticket
   moves in `release.yml`).
4. **GitHub**: secrets `ANTHROPIC_API_KEY`, `REVIEW_BASE_URL`, `REVIEW_API_KEY`, `JIRA_*`; variables
   `REVIEW_MODEL`, `DEPLOY_COMMAND`, `ROLLBACK_COMMAND`, `HEALTH_URL`, `OPS_*`. Fill in `.github/CODEOWNERS`,
   then `scripts/branch-protection.sh apply` and `verify`.
5. **Telemetry**: set `OTEL_EXPORTER_OTLP_ENDPOINT` to send events to your store; the JSONL file sink is always on.
6. **Alerts**: relay your alerting webhook to `repository_dispatch` (type `alert`). Alertmanager payloads are understood.
7. **Check it**: each developer runs `ai-sdlc doctor --project <JIRA KEY>` in the repo before the first ticket. It checks
   Claude Code against the pin, `gh` sign-in, the git remote, the configured checks, scope templates against the
   repo's folders, environments for unit worktrees, the review model, the Jira login and the project's statuses.
   It only reads; `--preflight` also runs the full checks at the current commit. It exits 1 on any failure.
8. **Optional, Paperclip**: as a live dashboard, set `paperclip.url`, `companyId` and `projectId`; every stage of every
   ticket then shows on its Paperclip issue. As a runner, a Paperclip "process" agent per repository runs `ai-sdlc paperclip-run`, and
   `ai-sdlc paperclip-sync` mirrors ready Jira tickets into its issues. Every step a person owns becomes a board
   approval in Paperclip. Setup: `docs/ARCHITECTURE.md#paperclip`.

## Defaults chosen for the plan's open questions (§9)

| Question | Default here | Change in |
| --- | --- | --- |
| Ready status | "In Progress", moved by the BA | `ai-sdlc.config.json` → `jira` |
| GitHub or GitLab | GitHub | `templates/github-workflows/`, `orchestrator/{pr,review,learn}.ts` |
| Model provider | Anthropic API; Bedrock/Vertex/Foundry via Claude Code env vars | CI secrets |
| Telemetry store | JSONL file + optional OTLP/HTTP | env |
| Cost cap | $5 per agent run, $40 per ticket | `budgetUsdPerRun`, `budgetUsdPerTicket` |

## Not verified here (needs your environment)

The Jira REST calls, the Atlassian/GitHub MCP endpoints in `.mcp.json`, the GitHub workflows, gitleaks/CodeQL,
branch protection, the Playwright walk and score observation, deployment commands, the alert relay
(Alertmanager → `repository_dispatch` needs a small relay holding a GitHub token) and the competing-model
gateway have not run against real services. No real agent has built a unit yet: the end-to-end test uses a
scripted agent; one real headless Claude Code run confirmed the runner's flags and output parsing.
