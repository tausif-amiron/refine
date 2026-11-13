// Stack profiles: what the workflow knows about each language ecosystem (profiles/<name>.json).
// Plain ESM with no dependencies, because hooks run from any worktree. Used by the hooks and, through
// profile.d.mts, by the TypeScript orchestrator.
//
// Two kinds of question:
// - Safe to answer with EVERY known profile (union): is this file a package manifest, is this command a package
//   install, which mutation rules fit this file type. A go.mod is a manifest even in a Node repo.
// - Answered with the repo's ACTIVE profiles: which scripts and dependencies it has, which files its linter reads.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROFILES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../profiles");

/** Where profiles are read from: AI_SDLC_PROFILES_DIR (tests, custom stacks), else the workflow's profiles/. */
export function profilesDir() {
  return process.env.AI_SDLC_PROFILES_DIR || PROFILES_DIR;
}

const cache = new Map();

export function loadProfile(name) {
  const key = `${profilesDir()}::${name}`;
  if (!cache.has(key)) {
    const p = join(profilesDir(), `${name}.json`);
    if (!existsSync(p)) throw new Error(`unknown stack profile "${name}" (no ${p})`);
    const profile = JSON.parse(readFileSync(p, "utf8"));
    for (const k of ["name", "detect", "sourceExtensions", "manifests", "packages", "tests", "mutation"]) {
      if (!(k in profile)) throw new Error(`profile ${name} is missing "${k}"`);
    }
    cache.set(key, profile);
  }
  return cache.get(key);
}

export function allProfiles() {
  return readdirSync(profilesDir()).filter((f) => f.endsWith(".json")).sort().map((f) => loadProfile(f.slice(0, -5)));
}

/** Profiles whose detect files exist at the repo root. */
export function detectProfiles(root) {
  return allProfiles().filter((p) => p.detect.some((f) => existsSync(join(root, f))));
}

/** The repo's active profiles: config `profiles`, else detected, else node (the behaviour before profiles). */
export function profilesFor(root, cfg) {
  if (Array.isArray(cfg?.profiles) && cfg.profiles.length) return cfg.profiles.map(loadProfile);
  const found = detectProfiles(root);
  return found.length ? found : [loadProfile("node")];
}

const base = (p) => p.split("/").pop() ?? p;

/** Package manifests and lockfiles of every known ecosystem. */
export function isManifest(path, profiles = allProfiles()) {
  const name = base(path);
  return profiles.some((p) => p.manifests.includes(name));
}

/** Which profile's source files this is (by extension), or undefined. */
export function profileForFile(path, profiles = allProfiles()) {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot) : "";
  return profiles.find((p) => p.sourceExtensions.includes(ext));
}

/**
 * Package installs in agent runs. Installing nothing new (lockfile sync) is allowed for any unit. Adding packages
 * is allowed only in the foundation unit, and only those its brief lists (from the IR's modules[].packages).
 * Returns a denial reason, or undefined when allowed.
 */
export function installDecision(command, brief, profiles = allProfiles()) {
  for (const p of profiles) {
    const m = command.match(new RegExp(p.packages.install.pattern));
    if (!m) continue;
    const names = packageArgs(p, m[1] ?? "");
    if (!names.length) continue;
    if (brief.kind !== "foundation") return `only the foundation unit adds packages; ask for ${names.join(", ")} with an owed.yaml entry (kind: dependency) to unit-foundation`;
    const allowed = new Set((brief.packages ?? []).map((n) => normaliseName(p, n)));
    const extra = names.filter((n) => !allowed.has(n));
    if (extra.length) return `${extra.join(", ")} not in this ticket's packages (${[...allowed].join(", ") || "none"}); packages come from the IR`;
  }
  return undefined;
}

/** Package names in an install command's arguments: flags, their values, paths and files are not packages. */
export function packageArgs(profile, args) {
  const spec = profile.packages.install;
  const nameRe = new RegExp(spec.name);
  const takesValue = new Set(spec.flagsWithValue ?? []);
  const skip = spec.skip ? new RegExp(spec.skip) : undefined;
  const out = [];
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) { if (takesValue.has(t)) i++; continue; }
    if (skip?.test(t)) continue;
    out.push(normaliseName(profile, t.match(nameRe)?.[1] ?? t));
  }
  return out;
}

/** Python package names compare case-insensitively with -, _ and . equal (PEP 503); others as written. */
function normaliseName(profile, name) {
  return profile.dependencies?.reader === "python" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}

/** Commands agents may never run (publishing, registry logins), from every profile. */
export function forbiddenCommand(command, profiles = allProfiles()) {
  for (const p of profiles) for (const f of p.packages.forbidden ?? []) if (new RegExp(f.pattern).test(command)) return f.why;
  return undefined;
}

function readJson(root, file) {
  const p = join(root, file);
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined; } catch { return undefined; }
}

/** Dependency names the repo declares, per its active profiles. */
export function readDependencies(root, profiles) {
  const names = new Set();
  for (const p of profiles) {
    const d = p.dependencies;
    if (d?.reader === "json-fields") {
      const doc = readJson(root, d.file) ?? {};
      for (const f of d.fields) for (const k of Object.keys(doc[f] ?? {})) names.add(k);
    } else if (d?.reader === "python") {
      for (const n of readPythonDependencies(root)) names.add(n);
    }
  }
  return names;
}

/**
 * Python dependency names: pyproject.toml ([project] dependencies and optional-dependencies, [dependency-groups],
 * [tool.uv] dev-dependencies, Poetry dependency tables) and requirements*.txt. A small line-based scan, not a full
 * TOML parser: enough to know which tools (pytest, ruff, mypy, ...) a project declares.
 */
export function readPythonDependencies(root) {
  const names = new Set();
  const add = (spec) => {
    const m = String(spec).trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) names.add(m[1].toLowerCase().replace(/[-_.]+/g, "-"));
  };
  const py = join(root, "pyproject.toml");
  if (existsSync(py)) {
    let section = "";
    let inArray = false;
    for (const raw of readFileSync(py, "utf8").split("\n")) {
      const line = raw.replace(/\s+#.*$/, "").trim();
      const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
      if (header && !inArray) { section = header[1].trim(); continue; }
      const listSection = /^(project\.optional-dependencies|dependency-groups)$/.test(section);
      const poetryTable = /^tool\.poetry\.(dependencies|dev-dependencies|group\.[^.]+\.dependencies)$/.test(section);
      if (inArray) {
        for (const q of line.matchAll(/["']([^"']+)["']/g)) add(q[1]);
        if (line.includes("]")) inArray = false;
        continue;
      }
      const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
      if (!kv) continue;
      const [, key, value] = kv;
      const isDepArray = (section === "project" && key === "dependencies") || listSection || (section === "tool.uv" && key === "dev-dependencies");
      if (isDepArray && value.startsWith("[")) {
        for (const q of value.matchAll(/["']([^"']+)["']/g)) add(q[1]);
        if (!value.includes("]")) inArray = true;
      } else if (poetryTable && key !== "python") add(key);
    }
  }
  for (const f of existsSync(root) ? readdirSync(root) : []) {
    if (!/^(dev-)?requirements([-_.][\w-]+)?\.txt$/.test(f)) continue;
    for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
      const l = line.trim();
      if (l && !l.startsWith("#") && !l.startsWith("-")) add(l);
    }
  }
  return names;
}

/** The command prefix the profile uses to run tools in this repo ("uv run", "poetry run", "python -m", or ""). */
export function runPrefix(root, profile) {
  for (const r of profile.run ?? []) if (!r.whenFile || existsSync(join(root, r.whenFile))) return r.prefix;
  return "";
}

/** Replace {run} with the repo's runner prefix. */
export function withRunner(root, profile, command) {
  return command.replaceAll("{run}", runPrefix(root, profile)).replace(/\s+/g, " ").trim();
}

/** Checks a profile derives from the tools a repo declares (profiles without project scripts, e.g. Python). */
export function toolChecks(root, profile, deps) {
  const out = { fast: [], full: [] };
  for (const c of profile.checks ?? []) {
    if (c.whenDependency && !deps.has(c.whenDependency)) continue;
    if (c.whenPath && !existsSync(join(root, c.whenPath))) continue;
    if (c.unlessPath && existsSync(join(root, c.unlessPath))) continue;
    for (const level of c.levels) out[level]?.push(withRunner(root, profile, c.command));
  }
  return out;
}

/** Project scripts (e.g. package.json scripts), per its active profiles. */
export function readScripts(root, profiles) {
  const out = {};
  for (const p of profiles) {
    const s = p.scripts;
    if (s?.reader === "json-field") Object.assign(out, readJson(root, s.file)?.[s.field] ?? {});
  }
  return out;
}

/** The command a profile uses to run a project script. */
export function scriptCommand(profile, script) {
  const c = profile.scripts?.command ?? {};
  return (c[script] ?? c.default ?? "{script}").replaceAll("{script}", script);
}

/** Which script a check command runs, if it runs one (e.g. "npm run -s lint" → "lint"). */
export function scriptOfCommand(profile, command) {
  for (const s of profile.scripts?.known ?? []) {
    if (scriptRuns(profile, s, command)) return s;
  }
  const generic = profile.scripts?.runs?.replace("{script}", "([\\w:-]+)");
  return generic ? command.match(new RegExp(generic))?.[1] : undefined;
}

/** True when `command` runs `script` (by the profile's run pattern, or its test runner for "test"). */
export function scriptRuns(profile, script, command) {
  const pattern = profile.scripts?.runs?.replace("{script}", script.replace(/[:]/g, "\\:"));
  if (pattern && new RegExp(pattern).test(command)) return true;
  return script === "test" && Boolean(profile.tests?.runnerPattern) && new RegExp(profile.tests.runnerPattern).test(command);
}
