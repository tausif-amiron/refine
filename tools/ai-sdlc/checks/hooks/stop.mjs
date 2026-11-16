#!/usr/bin/env node
// Stop / SubagentStop hook.
// 1. Agent runs: refuse to stop while the full checks fail, or while implementation changed without test
//    changes since the brief was issued (exit 2 → Claude keeps working). Only once per stop cycle
//    (stop_hook_active) so a stuck agent cannot loop forever; the orchestrator's gates still decide.
// 2. Always: emit a session_end telemetry event with token usage from the transcript.
import { existsSync, readFileSync } from "node:fs";
import { emit, loadBrief, loadConfig, matcher, readStdinJson, sh, tail } from "./lib.mjs";
import { isManifest } from "./profile.mjs";

const input = await readStdinJson();
const brief = loadBrief();

function usageFromTranscript(path) {
  const totals = { tokens_in: 0, tokens_out: 0, model: undefined, turns: 0 };
  if (!path || !existsSync(path)) return totals;
  const seen = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const msg = m.message;
    if (m.type !== "assistant" || !msg?.usage) continue;
    const id = msg.id ?? m.uuid;
    if (seen.has(id)) continue; // streamed chunks repeat the same usage
    seen.add(id);
    const u = msg.usage;
    totals.tokens_in += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    totals.tokens_out += u.output_tokens ?? 0;
    totals.model = msg.model ?? totals.model;
    totals.turns++;
  }
  return totals;
}

const telemetryOnly = process.argv.includes("--telemetry-only");
let blockReason;
if (brief && !input.stop_hook_active && !telemetryOnly) {
  const cfg = loadConfig();
  const changed = sh(`git diff --name-only ${brief.base_commit} && git ls-files --others --exclude-standard`).out.split("\n").filter(Boolean);
  const isTest = matcher([...(brief.tests ?? []), ...(cfg.tests?.globs ?? [])]);
  const source = changed.filter((f) => !isTest(f) && f !== "owed.yaml" && !f.startsWith(".ai-sdlc/") && !isManifest(f));
  const tests = changed.filter((f) => isTest(f));
  if (source.length && !tests.length) {
    blockReason = `Implementation changed but no test file changed since the brief was issued. Write tests from the contract first (docs/TESTING.md). Changed: ${source.join(", ")}`;
  } else {
    for (const cmd of brief.checks?.full ?? cfg.checks?.full ?? []) {
      const r = sh(cmd);
      if (r.code !== 0) { blockReason = `Full check failed: ${cmd} (exit ${r.code})\n${tail(r.out, 5000)}\nRun the full checks yourself to see all of it; they write .ai-sdlc/checks/full.log.`; break; }
    }
  }
}

const usage = usageFromTranscript(input.transcript_path);
await emit({
  event: "session_end",
  status: blockReason ? "fail" : brief ? "pass" : "info",
  model: usage.model,
  tokens_in: usage.tokens_in,
  tokens_out: usage.tokens_out,
  cost_source: "unknown",
  detail: { session_id: input.session_id, hook: input.hook_event_name, turns: usage.turns, blocked: Boolean(blockReason) },
});

if (blockReason) {
  process.stderr.write(blockReason);
  process.exit(2);
}
process.exit(0);
