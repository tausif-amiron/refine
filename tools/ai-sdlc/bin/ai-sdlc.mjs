#!/usr/bin/env node
// Launcher for client repos: `npm run ai-sdlc -- <command> [args]` (the installer adds that script).
// Runs the workflow's own TypeScript with its own dependencies, against the git repo you are in.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
if (!existsSync(tsx)) {
  console.error(`Workflow dependencies are not installed. Run: npm ci --prefix ${root}`);
  process.exit(1);
}
const [cmd = "", ...rest] = process.argv.slice(2);
const scripts = {
  report: ["scripts/report.ts"],
  dashboard: ["scripts/report.ts", "--html", ".ai-sdlc/dashboard.html"],
  mutation: ["checks/mutation/run.ts"],
};
const alias = { build: "run" };
const args = scripts[cmd] ? [...scripts[cmd].map((p, i) => (i === 0 ? join(root, p) : p)), ...rest] : [join(root, "orchestrator/cli.ts"), alias[cmd] ?? cmd, ...rest];
if (cmd === "simulator") {
  const r = spawnSync(process.execPath, [join(root, "simulator/server.mjs"), ...rest], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
// Inside a Paperclip run, TMPDIR is a deep per-run folder and tsx failed to create its IPC socket there
// ("listen EINVAL ... tsx-501/<pid>.pipe"); a short TMPDIR fixed it in the 2026-11-13 trial.
const env = process.env.PAPERCLIP_RUN_ID ? { ...process.env, TMPDIR: "/tmp" } : process.env;
const r = spawnSync(tsx, args, { stdio: "inherit", env });
process.exit(r.status ?? 1);
