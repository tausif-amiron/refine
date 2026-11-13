import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Stable JSON: keys sorted recursively, so identical input gives byte-identical output. */
export function stableStringify(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, indent) + "\n";
}

export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`;
  const t = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
  return `run-${d}-${t}-${randomBytes(2).toString("hex")}`;
}

export function writeFileEnsured(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonIfExists<T>(path: string, fallback: T): T {
  return existsSync(path) ? readJson<T>(path) : fallback;
}

export interface ExecResult { code: number; stdout: string; stderr: string }

/** Run a shell command synchronously. Never throws on non-zero exit. */
export function sh(cmd: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): ExecResult {
  const r = spawnSync("/bin/sh", ["-c", cmd], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 15 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? (r.signal ? 128 : 1), stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
}

/** Run a program with args (no shell) asynchronously. */
export function run(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Truncate long tool output for briefs and reports. Keeps the tail, where errors usually are. */
export function tail(text: string, maxChars = 6000): string {
  return text.length <= maxChars ? text : "…(truncated)…\n" + text.slice(-maxChars);
}

/** Expand ${VAR} from the environment; unset variables become "". */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? "");
}

/** Extract the first JSON object from model text (fenced or bare). Throws if none parses. */
export function extractJson<T = unknown>(text: string): T {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fenced.reverse(), text];
  for (const c of candidates) {
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(c.slice(start, end + 1)) as T; } catch { /* try next */ }
    }
  }
  throw new Error("No JSON object found in model output");
}
