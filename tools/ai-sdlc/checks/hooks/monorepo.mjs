// Monorepo support, shared by the orchestrator and the hooks (dependency-free: hooks run in worktrees that may have no
// node_modules). Config:
//   "monorepo": { "packages": "auto" | [{ "name", "dir" }],
//                 "checks": { "fast": [template], "full": [template] },
//                 "tests": { "command": template } }
// Templates take {name} (the package name) and {dir} (its folder); the test command also takes {out} and {files}.
// A unit's checks are the templates expanded for the packages it touches, then the repo-wide checks.fast/full once
// (the workflow's guards). Found on refine (pnpm, 38 packages): whole-repo checks on every attempt were minutes, the
// package's own were about 11 seconds.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };

/** The workspace's package globs, from pnpm-workspace.yaml, package.json workspaces or lerna.json. "!x" excludes. */
export function workspaceGlobs(root) {
  const pnpm = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    const out = [];
    let inPackages = false;
    for (const raw of readFileSync(pnpm, "utf8").split("\n")) {
      if (/^packages\s*:/.test(raw)) { inPackages = true; continue; }
      if (inPackages && /^\S/.test(raw)) break;
      const m = raw.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (inPackages && m) out.push(m[1].trim());
    }
    return out;
  }
  const pkg = readJson(join(root, "package.json"));
  const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (Array.isArray(ws)) return ws;
  const lerna = readJson(join(root, "lerna.json"));
  if (Array.isArray(lerna?.packages)) return lerna.packages;
  return [];
}

function expandGlob(root, glob) {
  const clean = glob.replace(/\/+$/, "");
  const parts = clean.split("/");
  const star = parts.findIndex((s) => s.includes("*"));
  if (star === -1) return [clean];
  const base = parts.slice(0, star).join("/");
  const deep = parts[star] === "**";
  const out = [];
  const walk = (rel, depth) => {
    let entries = [];
    try { entries = readdirSync(join(root, rel)); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const child = rel ? `${rel}/${e}` : e;
      try { if (!statSync(join(root, child)).isDirectory()) continue; } catch { continue; }
      out.push(child);
      if (deep && depth < 3) walk(child, depth + 1);
    }
  };
  walk(base, 0);
  return out;
}

/** Packages of the workspace: [{ name, dir }], sorted by folder. Empty when the repo is not a workspace. */
export function workspacePackages(root) {
  const globs = workspaceGlobs(root);
  const include = new Set(globs.filter((g) => !g.startsWith("!")).flatMap((g) => expandGlob(root, g)));
  for (const g of globs.filter((x) => x.startsWith("!"))) for (const d of expandGlob(root, g.slice(1))) include.delete(d);
  return [...include]
    .filter((dir) => existsSync(join(root, dir, "package.json")))
    .map((dir) => ({ name: readJson(join(root, dir, "package.json"))?.name ?? dir, dir }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The configured packages: an explicit list, or the workspace's ("auto"). */
export function packagesOf(root, cfg) {
  const p = cfg.monorepo?.packages;
  if (!cfg.monorepo) return [];
  return Array.isArray(p) ? p : workspacePackages(root);
}

const owner = (pkgs, path) => pkgs.filter((p) => path === p.dir || path.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];

/** Packages containing any of these files (in the packages' order). */
export function packagesForFiles(pkgs, files) {
  const hit = new Set(files.map((f) => owner(pkgs, f)).filter(Boolean));
  return pkgs.filter((p) => hit.has(p));
}

/** Packages a scope reaches: a glob counts when the fixed part before its first wildcard lies inside the package. */
export function packagesForScope(pkgs, globs) {
  const prefixes = globs.map((g) => g.split("/").filter((_, i, all) => !all.slice(0, i + 1).some((s) => /[*?{]/.test(s))).join("/"));
  return packagesForFiles(pkgs, prefixes.filter(Boolean));
}

const expand = (t, p) => t.replaceAll("{dir}", p.dir).replaceAll("{name}", p.name);

/** The checks for these packages: each package's templates, then the repo-wide checks once. */
export function effectiveChecks(cfg, pkgs) {
  const fast = cfg.checks?.fast ?? [];
  const full = cfg.checks?.full ?? [];
  if (!cfg.monorepo || !pkgs.length) return { fast, full };
  return {
    fast: [...pkgs.flatMap((p) => (cfg.monorepo.checks?.fast ?? []).map((t) => expand(t, p))), ...fast],
    full: [...pkgs.flatMap((p) => (cfg.monorepo.checks?.full ?? []).map((t) => expand(t, p))), ...full],
  };
}

/** Test files grouped by package, each group with its package's test command (files outside packages: tests.command). */
export function testRuns(cfg, pkgs, files) {
  const tpl = cfg.monorepo?.tests?.command;
  if (!tpl) return [{ command: cfg.tests.command, files }];
  const groups = new Map();
  for (const f of files) {
    const p = owner(pkgs, f);
    const key = p ? p.dir : "";
    if (!groups.has(key)) groups.set(key, { command: p ? expand(tpl, p) : cfg.tests.command, files: [] });
    groups.get(key).files.push(f);
  }
  return [...groups.values()];
}
