#!/usr/bin/env node
// CI gate: a PR into main may not carry open owed.yaml entries.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { projectDir } from "../hooks/lib.mjs";

const p = join(projectDir(), "owed.yaml");
const entries = existsSync(p) ? parse(readFileSync(p, "utf8")) ?? [] : [];
const open = entries.filter((e) => e.status === "open");
if (open.length) { console.error(`Open owed.yaml entries:\n${open.map((e) => `  ${e.id}: ${e.from} → ${e.to} (${e.note ?? e.kind})`).join("\n")}`); process.exit(1); }
console.log(`owed-closed: ${entries.length} entries, none open`);
