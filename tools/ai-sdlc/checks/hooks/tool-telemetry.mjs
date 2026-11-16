#!/usr/bin/env node
// PostToolUse hook (all tools): one tool_call telemetry event. Records the tool name and target only;
// never tool output or file contents.
import { emit, readStdinJson, relPath } from "./lib.mjs";

const input = await readStdinJson();
const ti = input.tool_input ?? {};
const target = ti.file_path ? relPath(ti.file_path) ?? "(outside project)" : ti.command ? String(ti.command).split(/\s+/).slice(0, 3).join(" ") : ti.pattern ?? undefined;
await emit({ event: "tool_call", status: "info", detail: { tool: input.tool_name, target, session_id: input.session_id } });
process.exit(0);
