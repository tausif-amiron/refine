#!/usr/bin/env node
// PostToolUse hook for Edit|Write|MultiEdit: run the fast checks (type check, lint) in agent runs,
// or in interactive sessions when AI_SDLC_FAST_CHECKS=1. On failure, exit 2 so Claude sees the output.
import { loadBrief, loadConfig, readStdinJson, sh, tail } from "./lib.mjs";

await readStdinJson();
if (!loadBrief() && process.env.AI_SDLC_FAST_CHECKS !== "1") process.exit(0);
const cfg = loadConfig();
for (const cmd of cfg.checks?.fast ?? []) {
  const r = sh(cmd);
  if (r.code !== 0) {
    process.stderr.write(`Fast check failed: ${cmd} (exit ${r.code})\n${tail(r.out, 4000)}\nFix this before continuing.`);
    process.exit(2);
  }
}
process.exit(0);
