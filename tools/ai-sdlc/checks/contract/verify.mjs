#!/usr/bin/env node
// Static contract check: for every OpenAPI contract in the ticket plans (ir/*.plan.json), each operation has a
// matching route registration in its owner unit's folders, and no route in those folders is missing from the
// contract. Route registrations are found with guards.routePattern from ai-sdlc.config.json.
// Runtime shape checks are the job of the contract-test helpers (index.mjs) in unit tests.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { globToRegExp, loadConfig, projectDir } from "../hooks/lib.mjs";
import { profileForFile } from "../hooks/profile.mjs";

/** "/invoices/:id" and "/invoices/{id}" → "/invoices/{}" */
export const normalisePath = (p) => p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "{}").replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "") || "/";

/** Route registrations in source text: [{ method, path, line }]. */
export function findRoutes(text, routePattern) {
  const re = new RegExp(`${routePattern}\\s*["'\`]([^"'\`]+)["'\`]`, "g");
  const out = [];
  for (const m of text.matchAll(re)) out.push({ method: m[1].toUpperCase(), path: m[2], line: text.slice(0, m.index).split("\n").length });
  return out;
}

/**
 * Compare contract operations with routes. A route implements an operation when the methods match and the
 * operation path equals the route path or ends with it (routers are often mounted under a prefix).
 */
export function compare(ops, routes) {
  const missing = ops.filter((o) => !routes.some((r) => r.method === o.method && endsWithPath(normalisePath(o.path), normalisePath(r.path))));
  const undocumented = routes.filter((r) => !ops.some((o) => o.method === r.method && endsWithPath(normalisePath(o.path), normalisePath(r.path))));
  return { missing, undocumented };
}

/** True when `tail` is the whole path or its last segments ("/{}" matches "/invoices/{}"). */
function endsWithPath(full, tail) {
  if (tail === "/") return full === "/";
  return full === tail || (tail.startsWith("/") && full.endsWith(tail));
}

function files(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (profileForFile(e) && !/\.(test|spec)\.|^test_|_test\.py$/.test(e)) out.push(p);
  }
  return out;
}

/** Source directories to scan for a unit: each non-test scope glob, cut back to the folder before its first wildcard. */
export function scopeDirs(scope) {
  const dirs = scope
    .filter((g) => !/(^|\/)(test|e2e)(\/|$)/.test(g) && g !== "owed.yaml")
    .map((g) => { const prefix = g.split(/[*?{]/)[0]; return prefix.slice(0, prefix.lastIndexOf("/")); })
    .filter(Boolean);
  return [...new Set(dirs)];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = projectDir();
  const cfg = loadConfig(root);
  const irDir = join(root, "ir");
  const plans = existsSync(irDir) ? readdirSync(irDir).filter((f) => f.endsWith(".plan.json")) : [];
  const problems = [];
  let checked = 0;
  for (const pf of plans) {
    const plan = JSON.parse(readFileSync(join(irDir, pf), "utf8"));
    for (const c of plan.contracts.filter((x) => x.path.startsWith("contracts/openapi/"))) {
      const owner = plan.units.find((u) => u.id === c.owner);
      if (!owner || !existsSync(join(root, c.path))) continue;
      const doc = parse(readFileSync(join(root, c.path), "utf8"));
      const ops = Object.entries(doc.paths ?? {}).flatMap(([p, item]) => Object.keys(item).filter((m) => /^(get|post|put|patch|delete)$/.test(m)).map((m) => ({ method: m.toUpperCase(), path: p })));
      const inScope = (f) => owner.scope.some((g) => globToRegExp(g).test(f));
      const routes = [];
      for (const d of scopeDirs(owner.scope)) for (const f of files(join(root, d))) {
        const rel = f.slice(root.length + 1);
        if (!inScope(rel)) continue;
        for (const r of findRoutes(readFileSync(f, "utf8"), cfg.guards.routePattern)) routes.push({ ...r, file: rel });
      }
      checked++;
      const { missing, undocumented } = compare(ops, routes);
      for (const o of missing) problems.push(`${c.path}: ${o.method} ${o.path} has no route in ${owner.id} (${scopeDirs(owner.scope).join(", ")})`);
      for (const r of undocumented) problems.push(`${r.file}:${r.line}: ${r.method} ${r.path} is not in ${c.path}`);
    }
  }
  if (problems.length) { console.error(`Contract check failed:\n${problems.join("\n")}`); process.exit(1); }
  console.log(`contract verify: ${checked} contract(s) match their routes`);
}
