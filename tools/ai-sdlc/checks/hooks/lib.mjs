// Shared helpers for Claude Code hooks and guard scripts. Plain ESM, no build step, fast start.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const WORKFLOW_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try { return data.trim() ? JSON.parse(data) : {}; } catch { return {}; }
}

/** Path of the workflow relative to the project ("." in the workflow repo, "tools/ai-sdlc" when installed). */
export function workflowRel(root = projectDir()) {
  const rel = relative(root, WORKFLOW_ROOT).split("\\").join("/");
  if (rel.startsWith("..")) return WORKFLOW_ROOT; // outside the repo: absolute, valid from any worktree depth
  return rel === "" ? "." : rel;
}

export function loadConfig(root = projectDir()) {
  const local = join(root, "ai-sdlc.config.json");
  const path = existsSync(local) ? local : join(WORKFLOW_ROOT, "ai-sdlc.config.json");
  const text = readFileSync(path, "utf8")
    .replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => (process.env[k] ?? "").replace(/["\\]/g, "\\$&"))
    .replaceAll("{workflow}", workflowRel(root));
  return JSON.parse(text);
}

/** The unit brief, when this session is an orchestrated agent run. Undefined for interactive sessions. */
export function loadBrief(root = projectDir()) {
  const p = process.env.AI_SDLC_BRIEF || join(root, ".ai-sdlc", "brief.json");
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; }
}

/**
 * Glob -> RegExp with no dependencies (hooks run from any worktree, where node_modules may be absent).
 * Supports **, *, ?, {a,b}; dotfiles match (like picomatch's dot: true).
 */
export function globToRegExp(glob) {
  return new RegExp("^" + globBody(glob) + "$");
}

function globBody(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        if (atStart && glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else if (atStart && i > 0 && i + 2 === glob.length) { re = re.slice(0, -1) + "(?:/.*)?"; i += 1; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) { re += "\\{"; continue; }
      re += "(?:" + glob.slice(i + 1, end).split(",").map(globBody).join("|") + ")";
      i = end;
    } else re += /[.+^$()|[\]\\]/.test(c) ? "\\" + c : c;
  }
  return re;
}

export function matcher(globs) {
  const ms = globs.map(globToRegExp);
  return (p) => ms.some((m) => m.test(p));
}

/** Path relative to the project, or undefined if it escapes the project. */
export function relPath(file, root = projectDir()) {
  const abs = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : rel.split("\\").join("/");
}

export const PROTECTED = ["**/.env", "**/.env.*", "secrets/**", "**/secrets/**", "**/*.pem", "**/*.key", "**/id_rsa*"];
export const PROTECTED_EXCEPTIONS = ["**/.env.example"];
/** Files an orchestrated agent may never change: its own guards and pipeline. */
export const AGENT_LOCKED = [".claude/**", "CLAUDE.md", "docs/**", "checks/**", ".github/**", "ai-sdlc.config.json", "orchestrator/**", "contracts/**", "ir/**", "tools/ai-sdlc/**", ".mcp.json"];

export function isProtected(rel) {
  return matcher(PROTECTED)(rel) && !matcher(PROTECTED_EXCEPTIONS)(rel);
}

/** PreToolUse decision output (Claude Code hook JSON). */
export function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}

export function telemetryContext() {
  const e = process.env;
  const ctx = {};
  if (e.AI_SDLC_RUN_ID) ctx.run_id = e.AI_SDLC_RUN_ID;
  if (e.AI_SDLC_TICKET) ctx.ticket = e.AI_SDLC_TICKET;
  if (e.AI_SDLC_UNIT) ctx.unit = e.AI_SDLC_UNIT;
  if (e.AI_SDLC_AGENT) ctx.agent = e.AI_SDLC_AGENT;
  if (e.AI_SDLC_ATTEMPT) ctx.attempt = Number(e.AI_SDLC_ATTEMPT);
  return ctx;
}

/** Emit a telemetry event (docs/TELEMETRY.md). File sink always; OTLP when configured. Never throws. */
export async function emit(event, root = projectDir()) {
  const record = { schema: "ai-sdlc.event.v1", ...telemetryContext(), ...event };
  record.ended_at ??= new Date().toISOString();
  try {
    let file = process.env.AI_SDLC_TELEMETRY_FILE;
    if (!file) { try { file = loadConfig(root).telemetry?.file; } catch { /* default below */ } }
    file ||= ".ai-sdlc/telemetry/events.jsonl";
    const path = isAbsolute(file) ? file : join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch { /* telemetry never breaks a session */ }
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  try {
    const headers = { "content-type": "application/json" };
    for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
      const i = pair.indexOf("=");
      if (i > 0) headers[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
    }
    const attributes = Object.entries(record).filter(([, v]) => v !== undefined).map(([k, v]) => ({ key: `ai_sdlc.${k}`, value: typeof v === "number" ? { doubleValue: v } : { stringValue: typeof v === "string" ? v : JSON.stringify(v) } }));
    await fetch(endpoint.replace(/\/$/, "") + "/v1/logs", {
      method: "POST", headers, signal: AbortSignal.timeout(2000),
      body: JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "ai-sdlc" } }] }, scopeLogs: [{ scope: { name: "ai-sdlc.hooks" }, logRecords: [{ timeUnixNano: String(Date.now() * 1e6), body: { stringValue: `${record.event}` }, attributes }] }] }] }),
    });
  } catch { /* ignore */ }
}

export function sh(cmd, cwd = projectDir()) {
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

export function tail(text, n = 6000) {
  return text.length > n ? "…\n" + text.slice(-n) : text;
}
