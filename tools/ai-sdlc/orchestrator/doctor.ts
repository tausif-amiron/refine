// ai-sdlc doctor: check this machine and repo before the first ticket. Read-only: it runs version and status
// commands, and makes two GET requests to Jira. Everything here was found by a failed run on AIT-1 or FA-001:
// a rejected or truncated Jira token, missing Jira statuses, no review model, scope templates from another stack,
// no integration checks, and environments that unit worktrees could not get.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { WORKFLOW_ROOT } from "./config.ts";
import { reviewModel } from "./review.ts";
import { profilesFor } from "../checks/hooks/profile.mjs";

export type Level = "pass" | "warn" | "fail";
export interface Finding { area: string; level: Level; detail: string; fix?: string }
export interface DoctorDeps {
  run(cmd: string, args: string[], cwd?: string, env?: Record<string, string>): { code: number; stdout: string; stderr: string };
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
}

export async function doctor(root: string, cfg: Config, deps: DoctorDeps, opts: { preflight?: boolean; project?: string } = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (area: string, level: Level, detail: string, fix?: string) => out.push({ area, level, detail, ...(fix ? { fix } : {}) });

  // Tools on this machine.
  const pinned = readFileSync(join(WORKFLOW_ROOT, ".claude-code-version"), "utf8").trim();
  const claude = deps.run(deps.env.CLAUDE_BIN ?? "claude", ["--version"]);
  const version = claude.code === 0 ? claude.stdout.match(/\d+\.\d+\.\d+/)?.[0] : undefined;
  if (!version) add("Claude Code", "fail", "the claude command was not found", `Install it: npm i -g @anthropic-ai/claude-code@${pinned}`);
  else if (version !== pinned) add("Claude Code", "warn", `${version} installed, ${pinned} pinned (.claude-code-version)`, `npm i -g @anthropic-ai/claude-code@${pinned}`);
  else add("Claude Code", "pass", `${version} matches the pin`);

  const gh = deps.run("gh", ["auth", "status"]);
  if (gh.code === 0) add("GitHub", "pass", "gh is signed in");
  else add("GitHub", "fail", "gh is missing or not signed in, so pr cannot open pull requests", "Run: gh auth login");

  // The repo.
  if (!existsSync(join(root, "ai-sdlc.config.json"))) add("Workflow installed", "fail", `no ai-sdlc.config.json in ${root}`, "Install the workflow: node <workflow>/scripts/install.mjs <repo>");
  else add("Workflow installed", "pass", "ai-sdlc.config.json found");

  // Unit worktrees are checkouts: agents only get permissions and hooks that are committed.
  const tracked = deps.run("git", ["ls-files", ".claude/settings.json", ".claude/agents"], root).stdout.split("\n").filter(Boolean);
  if (tracked.includes(".claude/settings.json") && tracked.some((f) => f.startsWith(".claude/agents/"))) add("Claude Code files", "pass", `.claude/settings.json and ${tracked.length - 1} agent definitions are committed`);
  else add("Claude Code files", "fail", ".claude/settings.json or .claude/agents/ is not committed, so agents in unit worktrees run with no permissions (every edit is denied) and no scope hooks", "Check .gitignore (re-run the installer with --update, which un-ignores them), then commit .claude/settings.json, agents, skills, commands and rules");

  const remote = deps.run("git", ["remote", "get-url", "origin"], root);
  if (remote.code === 0) add("Git remote", "pass", remote.stdout.trim());
  else add("Git remote", "warn", "no origin remote, so pr has nowhere to push", "git remote add origin <url>");

  if (!cfg.checks.full.length) add("Checks", "fail", "checks.full is empty, so no unit is checked", "Add the repo's lint, type check and test commands to checks.full");
  else add("Checks", "pass", `${cfg.checks.full.length} full checks, ${cfg.checks.fast.length} fast`);
  if (!cfg.checks.integration.length) add("Integration checks", "warn", "checks.integration is empty: QA runs only the contract check", "If the repo has slower or external tests, add the commands that run them to checks.integration");
  else add("Integration checks", "pass", `${cfg.checks.integration.length} configured`);

  const missingScope = Object.entries(cfg.scope ?? {})
    .filter(([kind]) => kind !== "always")
    .filter(([, globs]) => {
      const tops = globs.map((g) => g.split("/")[0]).filter((t) => t && !t.includes("*") && !t.includes("{") && globs.length);
      return tops.length > 0 && !tops.some((t) => existsSync(join(root, t)));
    })
    .map(([kind, globs]) => ({ kind, example: globs[0] }));
  if (missingScope.length) add("Scope templates", "warn", `${missingScope.map((m) => m.kind).join(", ")} point at folders this repo does not have (e.g. ${missingScope[0].example}); units of those kinds could not write anywhere real`, "Edit scope in ai-sdlc.config.json to match the repo's layout");
  else add("Scope templates", "pass", "every unit kind points at folders that exist");

  const envNames: string[] = (profilesFor(root, cfg) as { environments?: string[] }[]).flatMap((p) => p.environments ?? []);
  if (envNames.length && !envNames.some((n) => existsSync(join(root, n)))) add("Environment", "warn", `none of ${envNames.join(", ")} exists, so unit worktrees start without one`, "Create the environment in the repo first (e.g. uv sync)");
  else if (envNames.length) add("Environment", "pass", `${envNames.filter((n) => existsSync(join(root, n))).join(", ")} found; linked into unit worktrees`);

  // Gateway: it answers, and every key the agents will use is set and accepted (keys are never printed).
  const gwUrl = cfg.gateway?.url?.replace(/\/$/, "");
  if (gwUrl) {
    const vars = [...new Set(Object.values(cfg.gateway?.keys ?? {}))];
    const health = await deps.fetch(`${gwUrl}/health/liveliness`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status).catch(() => 0);
    const unset = vars.filter((v) => !deps.env[v]);
    const rejected: string[] = [];
    if (health === 200) for (const v of vars.filter((x) => deps.env[x])) {
      const s = await deps.fetch(`${gwUrl}/v1/models`, { headers: { authorization: `Bearer ${deps.env[v]}` }, signal: AbortSignal.timeout(10_000) }).then((r) => r.status).catch(() => 0);
      if (s !== 200) rejected.push(`${v} (HTTP ${s || "no answer"})`);
    }
    if (health !== 200) add("Gateway", "fail", `${gwUrl} did not answer its health check (${health ? `HTTP ${health}` : "no answer"})`, "Start the gateway (templates/litellm/README.md) or fix gateway.url / LITELLM_URL");
    else if (unset.length) add("Gateway", "fail", `${gwUrl} answers, but ${unset.join(", ")} ${unset.length === 1 ? "is" : "are"} not set`, "Create a virtual key per agent class at the gateway and export it under that name");
    else if (rejected.length) add("Gateway", "fail", `${gwUrl} rejected ${rejected.join(", ")}`, "Check the key at the gateway: it may be expired, revoked or over its budget");
    else add("Gateway", "pass", `${gwUrl} answers; ${vars.length} agent key${vars.length === 1 ? "" : "s"} accepted`);
  }

  // Review model.
  try { add("Review model", "pass", reviewModel(cfg, deps.env)); }
  catch (e) { add("Review model", "warn", (e as Error).message.split(". ")[0], "Set REVIEW_MODEL to a model no build agent uses (see docs/ARCHITECTURE.md#review-agent)"); }

  // Jira.
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = deps.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    add("Jira login", "warn", "JIRA_BASE_URL, JIRA_EMAIL or JIRA_API_TOKEN is not set: extract works only with --ticket-file", "Set all three in your shell profile");
  } else {
    const base = JIRA_BASE_URL.replace(/\/$/, "");
    const headers = { authorization: "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64"), accept: "application/json" };
    const host = (() => { try { return new URL(base).host; } catch { return base; } })();
    let res: Response | undefined;
    try { res = await deps.fetch(`${base}/rest/api/3/myself`, { headers, signal: AbortSignal.timeout(15_000) }); }
    catch (e) { add("Jira login", "fail", `could not reach ${host}: ${(e as Error).message}`, "Check JIRA_BASE_URL: the address before /browse/ in a ticket's URL"); }
    if (res && res.status === 200) {
      const me = (await res.json()) as { displayName?: string };
      add("Jira login", "pass", `signed in to ${host} as ${me.displayName ?? "(name hidden)"}`);
      // A project's own workflow decides which statuses its tickets can reach; the site list only says some project has them.
      const where = opts.project ? `project ${opts.project}` : "the site";
      const names = await (opts.project
        ? deps.fetch(`${base}/rest/api/3/project/${encodeURIComponent(opts.project)}/statuses`, { headers, signal: AbortSignal.timeout(15_000) })
          .then(async (r) => r.status === 200 ? ((await r.json()) as { statuses: { name: string }[] }[]).flatMap((t) => t.statuses.map((s) => s.name)) : undefined)
        : deps.fetch(`${base}/rest/api/3/status`, { headers, signal: AbortSignal.timeout(15_000) })
          .then(async (r) => r.status === 200 ? ((await r.json()) as { name: string }[]).map((s) => s.name) : undefined)
      ).catch(() => undefined);
      if (!names) add("Jira statuses", "warn", `could not read the statuses of ${where}`, opts.project ? `Check that project ${opts.project} exists and you can browse it` : undefined);
      else {
        const have = new Set(names.map((n) => n.toLowerCase()));
        // Every status the workflow moves a ticket to: ready (extract's gate), needs answers, and the stages.
        const wanted = [...new Set([cfg.jira.readyStatus, cfg.jira.needsAnswersStatus, ...Object.values(cfg.jira.stages ?? {})].filter((s): s is string => Boolean(s)))];
        const missing = wanted.filter((s) => !have.has(s.toLowerCase()));
        const label = opts.project ?? "the site";
        if (missing.length) add("Jira statuses", "warn", `${label} has no ${missing.map((s) => `"${s}"`).join(", ")}: tickets are not moved there${missing.includes(cfg.jira.readyStatus) ? ", and extract needs --force" : ""}`, "Add these statuses to the project's workflow, or change jira.readyStatus, jira.needsAnswersStatus and jira.stages to statuses it has");
        else add("Jira statuses", "pass", `${label} has all ${wanted.length}: ${wanted.map((s) => `"${s}"`).join(", ")}`);
        if (!opts.project) out.at(-1)!.detail += " (site-wide; add --project <KEY> to check one project's workflow)";
      }
    } else if (res && res.status === 401) {
      add("Jira login", "fail", `${host} rejected the email and token (401)`, [
        "JIRA_EMAIL must be the email of the Atlassian account that created the token (with Google sign-in, the Google email).",
        "The token must come from \"Create API token\" (not the scoped kind), copied whole with the Copy button.",
        "macOS: the `security add-generic-password ... -w` prompt cuts input at 128 characters; tokens are longer, so store it another way.",
      ].join(" "));
    } else if (res) {
      add("Jira login", "fail", `${host} answered HTTP ${res.status}`, "Check JIRA_BASE_URL: the address before /browse/ in a ticket's URL");
    }
  }

  // Optional and slow: the full checks at the current commit, as the preflight before a build runs them.
  if (opts.preflight) {
    // BASE_REF=HEAD: guards judge changes, as in the build preflight, not what the repo already contains.
    const r = deps.run("node", [join(WORKFLOW_ROOT, "checks", "hooks", "run-checks.mjs"), "full"], root, { BASE_REF: "HEAD" });
    if (r.code === 0) add("Preflight", "pass", "full checks pass at the current commit");
    else add("Preflight", "fail", r.stdout.trim().split("\n").slice(-6).join(" | "), "Fix the base branch first: every unit would fail the same checks");
  }
  return out;
}

const WORD: Record<Level, string> = { pass: "ok  ", warn: "WARN", fail: "FAIL" };

export function formatFindings(findings: Finding[]): string {
  const lines = findings.flatMap((f) => [`${WORD[f.level]}  ${f.area.padEnd(20)} ${f.detail}`, ...(f.fix && f.level !== "pass" ? [`      fix: ${f.fix}`] : [])]);
  const n = (l: Level) => findings.filter((f) => f.level === l).length;
  return [...lines, "", `${n("pass")} ok, ${n("warn")} warnings, ${n("fail")} failures`].join("\n");
}
