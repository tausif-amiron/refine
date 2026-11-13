#!/usr/bin/env node
// Guard: agents reference docs by path (and #section). Fail if a referenced file or section is missing,
// so docs and agent prompts cannot silently drift apart.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectDir, WORKFLOW_ROOT } from "../hooks/lib.mjs";

export function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, "").replace(/\s+/g, "-");
}

export function anchors(md) {
  return new Set(md.split("\n").filter((l) => /^#{1,6}\s/.test(l)).map((l) => slug(l.replace(/^#+\s*/, ""))));
}

function files(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out); else if (e.endsWith(".md") || e.endsWith(".ts")) out.push(p);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = projectDir();
  const sources = [join(root, "CLAUDE.md"), ...files(join(root, ".claude")), ...files(join(WORKFLOW_ROOT, "orchestrator")), ...files(join(root, "docs")).filter((f) => !f.includes("Build Plan"))].filter(existsSync);
  const problems = [];
  const re = /\b(docs\/[A-Za-z0-9_./-]+\.md)(#[a-z0-9_-]+)?/g;
  for (const src of sources) {
    const text = readFileSync(src, "utf8");
    for (const m of text.matchAll(re)) {
      const target = join(root, m[1]);
      if (!existsSync(target)) { problems.push(`${src.replace(root + "/", "")}: ${m[1]} does not exist`); continue; }
      if (m[2] && !anchors(readFileSync(target, "utf8")).has(m[2].slice(1))) problems.push(`${src.replace(root + "/", "")}: ${m[1]}${m[2]} section not found`);
    }
  }
  const unique = [...new Set(problems)];
  if (unique.length) { console.error(`Broken doc references:\n${unique.join("\n")}`); process.exit(1); }
  console.log(`docs-refs: ${sources.length} files checked`);
}
