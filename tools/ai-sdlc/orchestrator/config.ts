import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expandEnv } from "./util.ts";

export interface ServiceSpec {
  name: string;
  start: string;
  url: string;
  healthPath?: string;
  readyTimeoutSeconds?: number;
  env?: Record<string, string>;
}

export interface Config {
  /** Stack profiles (profiles/<name>.json) for this repo; detected from its files when absent. */
  profiles?: string[];
  ticketPrefix: string;
  branchPrefix: string;
  attemptsPerUnit: number;
  budgetUsdPerTicket: number;
  budgetUsdPerRun: number;
  concurrency: number;
  models: Record<string, string>;
  scope: Record<string, string[]>;
  tests: { globs: string[]; command: string; pinPattern?: string };
  checks: {
    fast: string[]; full: string[]; integration: string[]; contract: string[];
    /** ESLint-compatible command (e.g. "npx eslint"). When set, a unit fails only on lint errors it added. */
    lintChanged?: string;
  };
  /** Processes QA and the score need running (simulator, the app). Empty start + empty url = skipped. */
  services?: ServiceSpec[];
  /** Run the full checks in a clean worktree at the base commit before any agent (default true). */
  preflight?: boolean;
  /** Extra untracked paths to symlink into unit worktrees (node_modules are found automatically). */
  worktreeLinks?: string[];
  guards: { routePattern: string; authPattern: string; sourceDirs: string[] };
  mutation: {
    fastSubset: number;
    catalogue: string;
    /** The repo's own mutation tool: run it on catalogue entries a unit adds ({id} is replaced). */
    external?: { catalogue: string; idPattern: string; command: string };
  };
  jira: {
    readyStatus: string; needsAnswersStatus: string; fixDeployedStatus: string; acceptanceCriteriaHeading: string; opsLabel: string;
    /** Status the pipeline moves a ticket to at each stage. Unset or "" = the ticket stays where it is. */
    stages?: { escalated?: string; inReview?: string; released?: string };
  };
  /** After a unit's own model fails attemptsPerUnit times: `attempts` more on this model before a person takes over. */
  escalationModel?: { model: string; attempts: number };
  /** LLM gateway (LiteLLM) in front of agent runs; see orchestrator/gateway.ts. Empty url = direct to the provider. */
  gateway?: { url: string; keys?: Record<string, string>; headers?: Record<string, string> };
  /** Paperclip control plane, for `paperclip-sync` (runs get their own settings from Paperclip); see orchestrator/paperclip.ts. */
  paperclip?: { url: string; companyId: string; agentId: string; project?: string };
  release: { stages: number[]; healthUrl: string; deployCommand: string; rollbackCommand: string; watchMinutes: number; errorRateThreshold: number };
  ops: {
    preApprovedActions: string[];
    actionCommands: Record<string, string>;
    dedupWindowMinutes: number;
    maxTicketsPerServicePerHour: number;
    verifyWindowMinutes: number;
    metricCommand: string;
  };
  telemetry: { file: string };
}

/** Root of the ai-sdlc workflow package (where .claude/, checks/, ir/schema.json live). */
export const WORKFLOW_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Root of the client repository being worked on: AI_SDLC_REPO, else the git top level of the current
 * directory (so commands work from tools/ai-sdlc inside a client repo), else the current directory.
 */
export function repoRoot(): string {
  if (process.env.AI_SDLC_REPO) return process.env.AI_SDLC_REPO;
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

/**
 * The workflow's path as check commands should use it: "." in the workflow repo, "tools/ai-sdlc" when installed.
 * When the workflow lives outside the repo, an absolute path: commands also run inside unit worktrees, at a
 * different depth, where a "../" path would point somewhere else.
 */
export function workflowRel(root = repoRoot()): string {
  const rel = relative(root, WORKFLOW_ROOT).split("\\").join("/");
  if (rel.startsWith("..")) return WORKFLOW_ROOT;
  return rel === "" ? "." : rel;
}

/**
 * How to run a workflow command in this repo, for hints in messages: the npm script the installer added, the
 * launcher when the repo has no package.json, or the npm scripts of the workflow repo itself.
 */
export function cliHint(command: string, root = repoRoot()): string {
  const wf = workflowRel(root);
  if (wf === ".") return `npm run ${command.split(" ")[0]} -- ${command.split(" ").slice(1).join(" ")}`.trim();
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg.scripts?.["ai-sdlc"]) return `npm run ai-sdlc -- ${command}`;
  } catch { /* no package.json */ }
  return `node ${wf}/bin/ai-sdlc.mjs ${command}`;
}

export function loadConfig(root = repoRoot()): Config {
  const local = join(root, "ai-sdlc.config.json");
  const path = existsSync(local) ? local : join(WORKFLOW_ROOT, "ai-sdlc.config.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  delete raw.$comment;
  return resolveEnv(raw, workflowRel(root)) as Config;
}

/** Expand ${ENV} and {workflow} in every string of the config. */
export function resolveEnv(v: unknown, wf: string): unknown {
  if (typeof v === "string") return expandEnv(v).replaceAll("{workflow}", wf);
  if (Array.isArray(v)) return v.map((x) => resolveEnv(x, wf));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveEnv(x, wf)]));
  return v;
}

export function modelFor(cfg: Config, key: string): string {
  return cfg.models[key] || "sonnet";
}
