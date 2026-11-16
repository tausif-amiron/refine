#!/usr/bin/env node
// Run the configured checks and report them so an agent can act on the result.
//
//   node <workflow>/checks/hooks/run-checks.mjs fast      checks.fast (lint, type check)
//   node <workflow>/checks/hooks/run-checks.mjs full      checks.full (everything the gates run)
//   node <workflow>/checks/hooks/run-checks.mjs changed   checks.fast + only the tests changed since the brief's base
//
// The full output of every command goes to .ai-sdlc/checks/<level>.log (git-ignored). The terminal gets a short
// summary: each command with its result and time, and for a failure the last lines plus where the full log is.
// If Claude Code moves a long run to the background, the agent reads that log with the Read tool.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBrief, loadConfig, matcher, projectDir, sh, tail } from "./lib.mjs";
import { packagesOf, testRuns } from "./monorepo.mjs";

/** Pass/fail counts from a test report (JUnit XML or jest/vitest JSON), for the summary line. */
export function reportCounts(text) {
  if (!text) return undefined;
  if (text.trimStart().startsWith("<")) {
    const cases = (text.match(/<testcase\b/g) ?? []).length;
    const failed = (text.match(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g) ?? []).filter((c) => /<(failure|error)\b/.test(c)).length;
    return { passed: cases - failed, failed };
  }
  try {
    const j = JSON.parse(text);
    return { passed: j.numPassedTests ?? 0, failed: (j.numFailedTests ?? 0) + (j.numRuntimeErrorTestSuites ?? 0) };
  } catch { return undefined; }
}

/** Test files changed since the brief's base commit (committed, uncommitted and untracked). */
export function changedTestFiles(root, brief, cfg) {
  const base = brief?.base_commit;
  if (!base) return [];
  const listed = sh(`git diff --name-only ${base} && git ls-files --others --exclude-standard`, root).out.split("\n").filter(Boolean);
  const isTest = matcher([...(brief.tests ?? []), ...(cfg.tests?.globs ?? [])]);
  return [...new Set(listed)].filter((f) => isTest(f) && existsSync(join(root, f)));
}

export function runChecks(level, root = projectDir()) {
  const cfg = loadConfig(root);
  const brief = loadBrief(root);
  // In a monorepo the brief carries the checks for the unit's packages; outside a unit, the config's.
  const checks = { ...cfg.checks, ...(brief?.checks ?? {}) };
  const steps = [];
  if (level === "changed") {
    for (const c of checks.fast ?? []) steps.push({ label: c, cmd: c });
    const files = changedTestFiles(root, brief, cfg);
    if (files.length && cfg.tests?.command) {
      for (const run of testRuns(cfg, packagesOf(root, cfg), files)) {
        steps.push({ label: `tests changed since the brief (${run.files.length} file${run.files.length === 1 ? "" : "s"})`, cmd: run.command, files: run.files, report: true });
      }
    }
  } else {
    const cmds = checks[level];
    if (!Array.isArray(cmds)) return { code: 1, summary: `unknown check level "${level}" (fast, full, changed)` };
    for (const c of cmds) steps.push({ label: c, cmd: c });
  }
  const logDir = join(root, ".ai-sdlc", "checks");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${level}.log`);
  const logRel = `.ai-sdlc/checks/${level}.log`;
  writeFileSync(logPath, `# ${level} checks, ${new Date().toISOString()}\n`);
  const lines = [];
  for (const step of steps) {
    let cmd = step.cmd;
    let tmp;
    if (step.report) {
      tmp = mkdtempSync(join(tmpdir(), "ai-sdlc-checks-"));
      cmd = cmd.replace("{out}", join(tmp, "report")).replace("{files}", step.files.map((f) => `'${f}'`).join(" "));
    }
    const started = Date.now();
    const r = sh(cmd, root);
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    appendFileSync(logPath, `\n$ ${cmd}\n${r.out}\n→ exit ${r.code} (${secs}s)\n`);
    let counts;
    if (tmp) {
      const p = join(tmp, "report");
      counts = reportCounts(existsSync(p) ? readFileSync(p, "utf8") : "");
      rmSync(tmp, { recursive: true, force: true });
    }
    const countText = counts ? ` (${counts.passed} passed, ${counts.failed} failed)` : "";
    if (r.code !== 0) {
      lines.push(`✗ ${step.label}: exit ${r.code}${countText}, ${secs}s`, "", tail(r.out, 3000).trimEnd(), "", `Full output: ${logRel}`);
      return { code: r.code, summary: lines.join("\n") };
    }
    lines.push(`✓ ${step.label}${countText}, ${secs}s`);
  }
  if (level === "changed" && !steps.some((s) => s.report)) lines.push("(no changed test files to run)");
  lines.push(`✓ ${level} checks passed. Full output: ${logRel}`);
  return { code: 0, summary: lines.join("\n") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runChecks(process.argv[2] ?? "full");
  process.stdout.write(r.summary + "\n");
  process.exit(r.code);
}
