#!/usr/bin/env node
// Guard: every route registration in backend source carries auth (authPattern on the same statement)
// or an explicit "@public: <reason>" marker. Patterns come from ai-sdlc.config.json → guards.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, projectDir } from "../hooks/lib.mjs";
import { profileForFile } from "../hooks/profile.mjs";

/** Returns violations for one file's text. A statement runs from the route call to the matching ");". */
export function checkRoutes(text, routePattern, authPattern) {
  const route = new RegExp(routePattern, "g");
  const auth = new RegExp(authPattern);
  const violations = [];
  let m;
  while ((m = route.exec(text))) {
    let depth = 0, end = m.index;
    for (let i = text.indexOf("(", m.index); i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
    }
    const stmt = text.slice(m.index, end + 1);
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const prevLine = text.slice(text.lastIndexOf("\n", lineStart - 2) + 1, lineStart);
    if (!auth.test(stmt) && !/@public:\s*\S/.test(prevLine + stmt)) {
      violations.push({ line: text.slice(0, m.index).split("\n").length, snippet: stmt.split("\n")[0].slice(0, 120) });
    }
  }
  return violations;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (profileForFile(e) && !/\.(test|spec)\.|^test_|_test\.py$/.test(e)) out.push(p);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = projectDir();
  const g = loadConfig(root).guards ?? {};
  const findings = [];
  let n = 0;
  for (const d of g.sourceDirs ?? []) {
    const abs = join(root, d);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      n++;
      for (const v of checkRoutes(readFileSync(f, "utf8"), g.routePattern, g.authPattern)) findings.push(`${f.slice(root.length + 1)}:${v.line} ${v.snippet}`);
    }
  }
  if (findings.length) { console.error(`Routes without auth (add requireAuth, or "// @public: <reason>"):\n${findings.join("\n")}`); process.exit(1); }
  console.log(`auth-endpoints: ${n} files checked`);
}
