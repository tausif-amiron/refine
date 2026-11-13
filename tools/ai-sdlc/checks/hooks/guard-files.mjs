#!/usr/bin/env node
// PreToolUse hook for Read|Edit|Write|MultiEdit|NotebookEdit.
// Always: no reading or writing .env*, secrets/, keys.
// Orchestrated runs (a brief exists): writes only inside the unit's SCOPE (+ owed.yaml), and never to
// the workflow's own guards, pipeline, contracts or IR.
import { AGENT_LOCKED, deny, isProtected, loadBrief, matcher, readStdinJson, relPath, workflowRel } from "./lib.mjs";

const input = await readStdinJson();
const tool = input.tool_name ?? "";
const ti = input.tool_input ?? {};
const file = ti.file_path ?? ti.notebook_path ?? ti.path;
if (!file) process.exit(0);

const rel = relPath(file);
if (rel && isProtected(rel)) deny(`${rel} is protected (secrets). Never read or edit .env files, secrets/ or keys. Use .env.example for documentation.`);

const isWrite = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool);
if (!isWrite) process.exit(0);

const brief = loadBrief();
if (!brief) process.exit(0); // interactive session: a developer is in control

if (!rel) deny(`${file} is outside the project. Your SCOPE is: ${brief.scope.join(", ")}`);
const wf = workflowRel();
if (matcher([...AGENT_LOCKED, ...(wf === "." ? [] : [`${wf}/**`])])(rel)) deny(`${rel} is part of the workflow's guards, pipeline, contracts or IR; agents may not change it. If it must change, add an owed.yaml entry or say so in your final message.`);
const allowed = [...brief.scope, "owed.yaml"];
if (!matcher(allowed)(rel)) {
  deny(`${rel} is outside this unit's SCOPE (${brief.scope.join(", ")}). Do not edit it. If another unit must change it, add an entry to owed.yaml (docs/CONVENTIONS.md#owed-yaml).`);
}
process.exit(0);
