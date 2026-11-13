#!/usr/bin/env node
// Fail if the installed Claude Code CLI differs from the pinned version in .claude-code-version.
// Upgrade deliberately: bump the file in a branch and run the orchestrator smoke test (npm test).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pinned = readFileSync(new URL("../.claude-code-version", import.meta.url), "utf8").trim();
const r = spawnSync(process.env.CLAUDE_BIN ?? "claude", ["--version"], { encoding: "utf8" });
const installed = (r.stdout ?? "").match(/\d+\.\d+\.\d+/)?.[0];
if (!installed) { console.error("claude CLI not found; install with: npm i -g @anthropic-ai/claude-code@" + pinned); process.exit(1); }
if (installed !== pinned) { console.error(`Claude Code ${installed} installed, ${pinned} pinned (.claude-code-version).`); process.exit(1); }
console.log(`Claude Code ${installed} matches the pin`);
