// Start the processes QA and the blind score need (data-source simulator, the app), wait until each is
// healthy, and always stop them afterwards. Config: `services` in ai-sdlc.config.json.
//   - start + url: start it, poll url+healthPath until 2xx (or fail with the log tail).
//   - url only:    something else runs it (staging, docker compose); require it to be healthy.
//   - neither:     skipped.
// A service already healthy at its url is reused, not started twice.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceSpec } from "./config.ts";

export interface RunningServices {
  env: Record<string, string>;      // APP_URL, SIMULATOR_URL, ... for checks and agents
  started: string[];
  reused: string[];
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function healthy(url: string, timeoutMs = 2000): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).ok; } catch { return false; }
}

export const envName = (name: string) => `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_URL`;

export async function startServices(cwd: string, specs: ServiceSpec[], logDir: string, baseEnv: NodeJS.ProcessEnv = process.env): Promise<RunningServices> {
  mkdirSync(logDir, { recursive: true });
  const children: { name: string; child: ChildProcess }[] = [];
  const env: Record<string, string> = {};
  const started: string[] = [];
  const reused: string[] = [];
  const stop = async () => {
    for (const { child } of children.reverse()) await killGroup(child);
  };
  try {
    for (const s of specs) {
      if (!s.start && !s.url) continue;
      const health = s.url.replace(/\/$/, "") + (s.healthPath ?? "/");
      if (s.url) env[envName(s.name)] = s.url;
      if (s.url && (await healthy(health))) { reused.push(s.name); continue; }
      if (!s.start) throw new Error(`service "${s.name}" has no start command and is not healthy at ${health}`);
      if (!s.url) throw new Error(`service "${s.name}" has a start command but no url to check`);
      const logPath = join(logDir, `${s.name}.log`);
      const log = createWriteStream(logPath);
      const child = spawn("/bin/sh", ["-c", s.start], { cwd, detached: true, env: { ...baseEnv, ...env, ...s.env }, stdio: ["ignore", "pipe", "pipe"] });
      // Both streams feed one log, so neither may end it; it ends when the process has closed all its output.
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      const logWritten = new Promise<void>((resolve) => log.on("finish", () => resolve()));
      children.push({ name: s.name, child });
      started.push(s.name);
      const deadline = Date.now() + (s.readyTimeoutSeconds ?? 60) * 1000;
      let exited: number | null = null;
      // "close", not "exit": "exit" can come before the last output is read, and the log tail would miss it.
      child.on("close", (code) => { exited = code ?? -1; log.end(); });
      while (!(await healthy(health))) {
        if (exited !== null) {
          await logWritten;
          throw new Error(`service "${s.name}" exited with ${exited} before becoming healthy.\n${tailOf(logPath)}`);
        }
        if (Date.now() > deadline) throw new Error(`service "${s.name}" not healthy at ${health} after ${s.readyTimeoutSeconds ?? 60}s.\n${tailOf(logPath)}`);
        await sleep(300);
      }
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { env, started, reused, stop };
}

/** Run `fn` with services up; stop them whatever happens. */
export async function withServices<T>(cwd: string, specs: ServiceSpec[] | undefined, logDir: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const s = await startServices(cwd, specs ?? [], logDir);
  try { return await fn(s.env); } finally { await s.stop(); }
}

async function killGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const done = new Promise<void>((r) => child.once("exit", () => r()));
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  const timeout = sleep(5000).then(() => "timeout");
  if ((await Promise.race([done, timeout])) === "timeout") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    await done;
  }
}

function tailOf(path: string): string {
  try { return readFileSync(path, "utf8").split("\n").slice(-30).join("\n"); } catch { return "(no log)"; }
}
