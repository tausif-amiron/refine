<!-- ai-sdlc:start -->

# Architecture

This file describes the workflow itself. When the workflow is installed into a client repository,
add a `## Client system` section describing that product's systems, connectors and data flow.

## Flow

```
Jira ticket ──extract──> ir/<T>.ir.json ──plan──> units + contracts/ ──brief──> dev agents (worktrees)
   ^                                                                               │
   │                                       unit gates (scope, checks, seen-red, mutation, owed)
   │                                                                               │
   │                       QA (integration + walk) ──fail: fix brief (≤3 attempts)─┘
   │                              │ pass
   │                     blind score ──> PR ──> review agent (comments only) ──> CI gates
   │                                                                               │
   │                                        human approval ──> merge ──> release agent ──> production
   │                                                                                         │
   └──────────── deduplicated ticket <── ops agent triage <── alert ─────────────────────────┘
```

## Components

| Component     | Entry point                                                 | Model?                                                             |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Ticket skill  | `/ticket` (`.claude/skills/ticket`)                         | yes, interactive                                                   |
| Extract       | `npm run extract -- <T>` → `orchestrator/extract.ts`        | yes (`extract` agent); sealing, anchors and schema checks are code |
| Planner       | `npm run plan -- <T>` → `orchestrator/plan.ts`              | no; deterministic                                                  |
| Build loop    | `npm run build-ticket -- <T>` → `orchestrator/run.ts`       | yes (`dev-*`, `qa`), gates are code                                |
| Score         | `npm run score:probe`, `/score`, `npm run score:finalize`   | probe agent observes; a person judges                              |
| PR            | `npm run pr -- <T>` → `orchestrator/pr.ts`                  | no                                                                 |
| Review        | `.github/workflows/review.yml` → `orchestrator/review.ts`   | yes (competing model); posting is code, `COMMENT` only             |
| Gates         | `.github/workflows/gates.yml`                               | no                                                                 |
| Release       | `.github/workflows/release.yml` → `orchestrator/release.ts` | yes for notes/risk; rollout and rollback are code                  |
| Ops           | `.github/workflows/ops.yml` → `orchestrator/ops.ts`         | yes for triage; dedup, actions, tickets are code                   |
| Learning loop | `npm run learn` → `orchestrator/learn.ts`                   | no                                                                 |

**Stacked PRs.** When a PR's base branch is itself the head of another PR (or a branch the workflow cut from another),
the PR description and the `pr` command warn: merge the lower PR first, then re-target this one (or delete the lower
branch on merge so GitHub re-targets it). If the lower PR has already merged, `pr` refuses and names the branch to
target instead, because a PR merged into an already-merged branch never reaches its destination.

## Agent runner

Agents run headless through the Claude Code CLI (`orchestrator/runner.ts`):
`claude -p --agent <name> --output-format json --model <m> --tools <list> --permission-mode dontAsk --max-budget-usd <n>`,
in the unit's worktree, with the brief as the prompt. The agent definition in `.claude/agents/<name>.md` is the
same file a developer gets in an interactive session. The CLI version is pinned in `.claude-code-version`
and checked by `npm run check:claude-version`. An Agent SDK runner (`@anthropic-ai/claude-agent-sdk`) is
available with `AI_SDLC_RUNNER=sdk`.

## access-model

| Agent   | Jira                       | Repo                                     | Production                                         | Other            |
| ------- | -------------------------- | ---------------------------------------- | -------------------------------------------------- | ---------------- |
| extract | read (fetched by script)   | read-only                                | none                                               | —                |
| plan    | —                          | write contracts/units on branch          | none                                               | —                |
| dev-\*  | —                          | write within SCOPE on unit branch        | none                                               | simulator        |
| qa      | —                          | write tests and walked screens on branch | none                                               | browser          |
| score   | —                          | none (empty working dir)                 | none                                               | browser only     |
| review  | read                       | read + comment on PR                     | none                                               | second model     |
| release | —                          | read                                     | deploy via pipeline only                           | release platform |
| ops     | write tickets (via script) | read                                     | read logs/metrics; pre-approved actions via script | alerting         |

Each class gets its own credentials with the minimum above. No agent holds a person's token.

## jira-write-back

No agent writes to Jira. Scripts post comments with the Jira credentials (`JIRA_BASE_URL`, `JIRA_EMAIL`,
`JIRA_API_TOKEN`), and only on tickets that `extract` read from Jira (not `--ticket-file`):

| When                        | Comment                                                                           | Code                                            |
| --------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `extract` writes a valid IR | IR summary: modules, entities, screens, services, roles, questions, unplaced text | `irSummary` in `orchestrator/extract.ts`        |
| `plan`                      | each question with its answer, and the planned units                              | `answersComment` in `orchestrator/jira-sync.ts` |
| `pr` opens or updates a PR  | the PR link and its base branch                                                   | `prComment` in `orchestrator/jira-sync.ts`      |
| a unit escalates            | the escalation reason and last attempt                                            | `orchestrator/escalate.ts`                      |

Each kind is posted again only when its text changes (`.ai-sdlc/tickets/<T>.json` records what was posted), so
re-running a step does not repeat a comment.

The scripts also move the ticket along the pipeline (`moveTicket` in `orchestrator/jira-sync.ts`). A person
moves it to `jira.readyStatus` to start extraction; after that:

| When                                                                                  | Ticket moves to (config)  | Default       |
| ------------------------------------------------------------------------------------- | ------------------------- | ------------- |
| `extract` leaves questions or unplaced text                                           | `jira.needsAnswersStatus` | Needs answers |
| `plan` runs on a ticket that was moved to Needs answers                               | `jira.readyStatus`        | In Progress   |
| a unit escalates                                                                      | `jira.stages.escalated`   | Blocked       |
| `pr` opens the pull request                                                           | `jira.stages.inReview`    | In Review     |
| `release.yml` finishes the watch window (`release done`, keys from `Ticket:` footers) | `jira.stages.released`    | Done          |

Each stage moves a ticket once (recorded in the same file). A stage whose status is `""`, or a status the
ticket's workflow cannot reach from where it is, leaves the ticket where it is and the command says so; it never
fails the step. Like comments, only tickets read from Jira move, except `release done`, which runs in CI and
moves the keys of this repo's project (`ticketPrefix`) named in the released commits.

## monorepos

In a JS workspace (pnpm-workspace.yaml, package.json `workspaces`, or lerna.json) the installer writes a `monorepo`
section: per-package check templates (`{name}`, `{dir}`; lint, type check, the package's own test and build, picked
from what the repo and most packages have), a per-package test command, and walk specs inside each package
(`<workspace glob>/test/walk/**`). The root checks keep only the workflow's repo-wide guards. Each unit's brief lists
the packages its scope reaches and the checks expanded for them; the gates, the agent's own check runs
(`run-checks.mjs`, the stop hook), the preflight and QA use those, and test files run with their own package's
command. On refine (37 packages) that is about 11 seconds per check run instead of the whole repo. `doctor` reports
the packages found. Shared code: `checks/hooks/monorepo.mjs`.

## pull-requests-from-a-fork

When you cannot push to `origin` (an open-source project), set `pr.remote` to your fork's git remote and `pr.repo` to
the fork (`owner/name`). `pr` then pushes there and every `gh` call (`pr`, `review`, `learn`) names that repo, so
nothing opens on the upstream project unless `pr.repo` says so. Defaults: `origin`, and gh's own choice of repo.

## paperclip

**Dashboard.** With `paperclip.url`, `paperclip.companyId` and `paperclip.projectId` set (`report` defaults to on),
every command reports on the ticket's Paperclip issue (`orchestrator/dashboard.ts`): one issue per ticket in the repo's
project, named after the IR's title, owned by the board user (Paperclip will not put an unassigned issue in progress).
Each stage posts what started and how it ended; the build, gates and QA post their progress lines as they happen. A
person-step (IR questions, an escalated unit, a failure) blocks the issue on the board with what to do; an open PR
moves it to in review. Reporting never breaks a run (one warning if Paperclip is down), and it only reports: it is not
a runner, so it starts nothing. `PAPERCLIP_BOARD_KEY` when the instance requires authentication.

Paperclip (self-hosted agent control plane) is the dashboard and scheduler around the workflow; it does not replace
any step or gate. Jira stays the source of truth, code still decides pass or fail, and a person still approves.

- **Sync**: `ai-sdlc paperclip-sync [--project KEY] [--dry-run]` creates one Paperclip issue per Jira ticket in
  `jira.readyStatus`, titled `KEY: summary`, in the repository's Paperclip project. It lands unassigned in the
  backlog: a person starts a ticket by assigning its issue to the runner agent (`paperclip.autoStart: true` assigns
  every new one at once instead). Tickets already in Paperclip are skipped, so it is safe on a schedule. Settings:
  `paperclip.url`, `.companyId`, `.agentId`, `.project`, `.projectId` (`PAPERCLIP_URL`, `PAPERCLIP_COMPANY_ID`,
  `PAPERCLIP_RUNNER_AGENT_ID`, `JIRA_PROJECT`); `PAPERCLIP_BOARD_KEY` when the instance requires authentication.
- **Schedule**: run the sync every few minutes from the repository, in a shell that has the Jira variables. cron
  (a server): `*/5 * * * * cd <repo> && zsh -ic 'node tools/ai-sdlc/bin/ai-sdlc.mjs paperclip-sync' >> <log> 2>&1`.
  macOS: a launchd agent in `~/Library/LaunchAgents` with `StartInterval` 300 running the same command
  (`launchctl bootstrap gui/$(id -u) <plist>`; `launchctl bootout` removes it). Paperclip itself must be running.
- **Runner**: one Paperclip agent per repository with the `process` adapter, command `node`, args
  `["<repo>/tools/ai-sdlc/bin/ai-sdlc.mjs", "paperclip-run"]`, `cwd` the repository. Each run acts only on the issue
  that woke it (`orchestrator/paperclip.ts`): it runs `extract`, `plan` and `run` (build and QA) as needed, comments
  each step's exit code and output, and stops when a person is needed. Tickets share the repository's checkout, so each
  run first switches to its ticket's branch; a new ticket's branch is cut from `<pr.remote>/<pr.base>` (fetched; default
  the remote's default branch), never from whatever is checked out, so queued tickets do not stack. Uncommitted changes
  to tracked files stop the run with a note on the issue.
- **People**: open IR questions become a Paperclip question set on the issue (`ask_user_questions`). Before the first
  ask, the advisor agent (read-only, Opus; `ai-sdlc suggest T`, `orchestrator/advise.ts`) writes `ir/<T>.advice.json`:
  2-4 options per question, one recommended, each with its reasoning, `path:line` evidence (checked to exist), what
  breaks if it is wrong and a confidence. Each question then shows the recommended option first, the alternatives, and
  "Your own answer" (free text); the reasoning is in each option's description. If the advisor fails, the questions
  are asked without options. A picked option's answer (plus any note) or the developer's own text goes into the IR;
  answering wakes the runner, which commits the answers and goes on to plan and build.
- **Questioning a recommendation** (#advice-commands): a person types a command as a comment on the issue; the
  comment wakes the runner, which answers as the agent. `/why Q-n`: the full case (reasoning, evidence,
  assumptions, weakest link). `/grill Q-n [doubt]`: an adversarial review that argues for the alternatives and names
  the code and tests to read before deciding. `/tutor Q-n`: a Socratic session (adapted from Jane Street's MIT
  socratic-tutor skill); the developer replies in plain comments, `/tutor stop` ends it (Sonnet; `models.tutor`).
  `/help` lists them. The commands are skills (`.claude/skills/{why,grill,tutor}`), so they also work in Claude Code.
  Paperclip treats a question set as history once a person comments after it, so after a comment the runner
  withdraws the old set and asks again; answers given on an older set still count. Only people's comments are read
  as commands, never the agent's own, nor the workflow's comments posted as the board (they start with the hidden
  marker `<!-- ai-sdlc -->`). A /tutor session ends once its question is answered.
- **Usage and cost** (#paperclip-usage): after every step and command, the runner posts the ticket's new agent-run
  costs to Paperclip's cost ledger (`POST /companies/:id/cost-events`, one per model per run, idempotent), so the
  issue's cost summary and Paperclip's Costs pages show them. Runs on a subscription (they reported a plan window)
  are `subscription_included` with the API-equivalent cost as an estimate. When the PR opens, a usage summary goes
  on the issue: story points, cost and cost per point, tokens, and the plan's 5-hour window (runs under 1% each are
  reported as such, with the window's movement across the ticket as an upper bound). `ai-sdlc paperclip-usage T
[--summary]` posts the same for tickets run before this, or from the CLI. Paperclip can also show the plan's own
  quota windows if a person connects the subscription under AI connections. An escalated unit, a failed step, and opening the PR each become a
  `request_board_approval` on the issue, which is then `blocked`. Approving wakes the runner: for the PR it runs `pr`
  (one approval, one PR), otherwise it re-checks and continues. Rejecting parks the issue in `backlog` with the note.
  An open PR moves the issue to `in_review`; approving and merging the PR itself stays on GitHub.
- **Environment**: Paperclip isolates GitHub inside runs. Store a fine-grained token (only the fork's repository;
  Contents and Pull requests: read and write) as a Paperclip secret bound to the agent as `AI_SDLC_GH_TOKEN`; the
  runner hands it only to `pr` (as `GH_TOKEN`, used by `gh` and by `git push` through a one-off credential helper) and
  removes it from every other step, so agents never see it; Jira and gateway credentials (`JIRA_*`, `LITELLM_*`) likewise go in the agent's environment
  or Paperclip secrets, not a person's shell profile.

## review-agent

The review agent must use a different model from the build agents. Set `REVIEW_BASE_URL` (an LLM gateway
that speaks the Anthropic Messages API and routes to the competing provider), `REVIEW_API_KEY` and
`REVIEW_MODEL` as repository secrets. The workflow passes them to Claude Code as `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN` and `--model`. Choosing the competing model is a team policy decision. Without `REVIEW_MODEL` (or
`models.review`), or with a model the build agents also use, the review refuses to run rather than falling back.
With the LiteLLM gateway (below), the competing model is one more `model_name` in its config, and the review agent
uses its own key (`LITELLM_KEY_REVIEW`); `REVIEW_BASE_URL` still overrides that for the review agent alone.

## llm-gateway

When `gateway.url` is set (`LITELLM_URL`), every agent run goes through an LLM gateway that serves the Anthropic
Messages API; LiteLLM is the reference (`templates/litellm/`). The runner (`orchestrator/gateway.ts`) gives each run
the gateway's address, the key for its agent class (`gateway.keys.<agent>`, else `gateway.keys.default`: an
environment variable name, never a value) and an empty `ANTHROPIC_API_KEY`, so provider keys stay in the gateway.
`gateway.headers` tags each call (default `x-litellm-tags: ticket:{ticket},agent:{agent}`), so the gateway's spend
logs give cost per ticket and agent independently of what Claude Code reports. Budgets per agent class are set on
its key at the gateway, on top of `--max-budget-usd` per run. A run whose key is not set fails before it starts.
Build agents stay on Claude; only the review agent uses a competing model. `ai-sdlc doctor` checks that the gateway
answers and accepts each key.

## configuration

`ai-sdlc.config.json` holds per-repo settings: scope templates per unit kind (`{name}` is the kebab-case IR
name), test command, check commands, attempt and budget caps, models per agent, the escalation model (`escalationModel`: after `attemptsPerUnit` failures, `attempts` more on a stronger model, by default one on opus, before a person; setup problems go straight to a person), Jira statuses, release
stages and thresholds, ops pre-approved actions. Values like `${HEALTH_URL}` are read from the environment;
`tools/ai-sdlc` is the workflow's folder relative to the repo (`.` here, `tools/ai-sdlc` when installed).

- `scope.wiring`: the shared files no feature unit owns (routes, nav, app/router registration). The wiring
  unit runs after every screen and service and registers them. `scope.foundation` owns package.json and lockfiles.
- `checks.lintChanged`: an ESLint-compatible command (e.g. `npx eslint`). Each changed file is linted now and at
  the unit's base commit; the unit fails only on errors it added. Use it when the repo's code already has lint
  errors, instead of putting a whole-repo lint in `checks.full`.
- `services`: processes QA and the blind score need (`simulator`, `app`). With `start` and `url`, the
  orchestrator starts it, waits for `url + healthPath`, and stops it afterwards; with only `url`, it must already
  be healthy (staging, docker compose). Their URLs reach checks and agents as `APP_URL`, `SIMULATOR_URL`.
- `worktreeLinks`: extra untracked paths to link into unit worktrees. Every installed environment the profiles
  name (`node_modules`, `.venv`, `venv`; root and per app) is linked automatically, kept out of git, and unlinked
  before the worktree is removed. Files the main checkout overrides locally but hides from git (`skip-worktree`,
  `assume-unchanged`, e.g. a machine-specific dependency pin) are copied into each worktree and hidden the same way,
  so units run in the same environment and the override is never committed. Tool caches the profiles name
  (`.mypy_cache`, `.ruff_cache`, `.pytest_cache`, `.eslintcache`) are copied (not linked, since units run in
  parallel) so checks start warm: on frontend-agent, mypy took 146 s in a fresh worktree and 2.6 s with its cache.
- `preflight` (default true): before any agent runs, the full checks run once in a clean worktree at the ticket
  branch's head. If they fail there, the build stops and says the environment is the problem.

## stack-profiles

Everything the workflow needs to know about a language ecosystem lives in one file, `profiles/<name>.json`, so the
core (IR, planner, briefs, gates, owed.yaml, review, release, ops) stays language-neutral. A profile declares:

| Field                                    | Used for                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `detect`                                 | files that mark a repo as this stack (e.g. `package.json`)                                            |
| `sourceExtensions`                       | which files mutation and the lint gate apply to                                                       |
| `manifests`                              | package manifests and lockfiles: owned by the foundation unit, no tests required, never mutated       |
| `packages.install`, `packages.forbidden` | the install guard (only the foundation unit adds the IR's packages) and commands agents may never run |
| `dependencies`, `scripts`                | how to read the repo's dependencies and project scripts (installer detection, PR "not gated" list)    |
| `tests`                                  | test file patterns, runner commands by dependency, report format                                      |
| `lint`                                   | the lint command for "no new lint errors", its output format, config files to warn about              |
| `mutation.operators`                     | which built-in mutation rule set applies                                                              |
| `routes`                                 | route and auth patterns for the auth guard and the contract check                                     |

Some questions use every known profile at once (is this file a manifest, is this command a package install, which
mutation rules fit this file): a `go.mod` is a manifest even in a Node repo. Others use the repo's active profiles
(`profiles` in `ai-sdlc.config.json`, else detected from its files): which scripts and dependencies it has, which
files its linter reads. `AI_SDLC_PROFILES_DIR` points the workflow at another profiles folder.

Profiles today: `node` (JavaScript and TypeScript) and `python` (uv, pip, poetry, pdm; pytest, ruff, mypy). Test
reports are read as JUnit XML or jest JSON, detected from their content. A profile without project scripts derives its
checks from the tools a repo declares (`checks`, run through the repo's runner: `uv run`, `poetry run`, `python -m`),
and lists the Claude Code permissions its toolchain needs in agent runs (`permissions`; the installer merges them into
the client's settings). The workflow's own runtime is Node in every stack.

## installation

`node scripts/install.mjs <client-repo>` copies the runtime to `tools/ai-sdlc/`, the agents, skills and
commands to `.claude/`, merges hooks and permissions into `.claude/settings.json`, appends a marked block to
`CLAUDE.md` and existing docs, writes `ai-sdlc.config.json` from what the repo has (test runner, npm
scripts), and adds `npm run ai-sdlc -- <command>`. `--update` replaces only workflow-owned files; the team's
config, rules and doc edits survive. The workflows find the runtime through one variable, `W`.

## Simulator

`simulator/server.mjs` stands in for a legacy data source with no API (HTML page, CSV export) and exposes
`/healthz`, `/metrics` and a fault switch (`POST /__fault`). Integration checks and the ops demo run against it.
Rate limit of the simulated source: 60 requests/minute (wrappers must back off on 429).

<!-- ai-sdlc:end -->
