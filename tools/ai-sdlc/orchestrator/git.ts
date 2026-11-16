// Git and worktree helpers. One worktree per unit; the orchestrator merges a unit branch into the
// ticket branch only after the unit passes its gates.
import { allProfiles } from "../checks/hooks/profile.mjs";
import { cpSync, copyFileSync, appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { sh } from "./util.ts";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function git(cwd: string, args: string) {
  return sh(`git ${args}`, { cwd });
}

function must(cwd: string, args: string): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args} failed in ${cwd}:\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export const headCommit = (cwd: string) => must(cwd, "rev-parse HEAD");
export const currentBranch = (cwd: string) => must(cwd, "rev-parse --abbrev-ref HEAD");
export const isClean = (cwd: string) => git(cwd, "status --porcelain").stdout.trim() === "";

export function ticketBranch(prefix: string, ticket: string): string {
  return `${prefix}${ticket}`;
}

export function unitBranch(ticketBr: string, unitId: string): string {
  return `${ticketBr}--${unitId}`;
}

/** Check out the ticket branch, creating it from the current HEAD if needed. */
export function ensureBranch(root: string, branch: string): void {
  if (currentBranch(root) === branch) return;
  const exists = git(root, `rev-parse --verify --quiet ${q(branch)}`).code === 0;
  if (exists) { must(root, `checkout ${q(branch)}`); return; }
  const from = currentBranch(root);
  must(root, `checkout -b ${q(branch)}`);
  // Remember where the ticket branch came from, so its PR targets that branch (local git config only).
  if (from !== "HEAD") git(root, `config ${q(`branch.${branch}.ai-sdlc-base`)} ${q(from)}`);
}

/**
 * Put the working copy on a ticket's branch for an unattended run (Paperclip): check it out if it exists, else cut it
 * from `<remote>/<base>` (fetched first) and record `base` as its PR base. Cutting from whatever happened to be checked
 * out would stack each queued ticket on the one before it. Refuses to leave uncommitted changes to tracked files.
 */
export function useTicketBranch(root: string, branch: string, o: { remote: string; base?: string }): void {
  const current = currentBranch(root);
  if (current === branch) return;
  if (git(root, "status --porcelain --untracked-files=no").stdout.trim()) {
    throw new Error(`the working copy has uncommitted changes on ${current}; commit or stash them, then approve to retry`);
  }
  if (git(root, `rev-parse --verify --quiet ${q(`refs/heads/${branch}`)}`).code === 0) { must(root, `checkout ${q(branch)}`); return; }
  const base = o.base ?? (git(root, `symbolic-ref --short ${q(`refs/remotes/${o.remote}/HEAD`)}`).stdout.trim().replace(`${o.remote}/`, "") || "main");
  must(root, `fetch ${q(o.remote)} ${q(base)}`);
  must(root, `checkout --no-track -b ${q(branch)} ${q(`${o.remote}/${base}`)}`);
  git(root, `config ${q(`branch.${branch}.ai-sdlc-base`)} ${q(base)}`);
}

/**
 * The branch a ticket branch should merge into: the one recorded when it was created, else the closest
 * local branch whose tip is an ancestor of it (the most recent one), else "main".
 */
export function baseBranchOf(root: string, branch: string): string {
  const recorded = git(root, `config --get ${q(`branch.${branch}.ai-sdlc-base`)}`).stdout.trim();
  if (recorded) return recorded;
  const locals = git(root, "for-each-ref '--format=%(refname:short)' refs/heads").stdout.split("\n")
    .filter((b) => b && b !== branch && !b.startsWith(`${branch}--`));
  const isAncestor = (a: string, b: string) => git(root, `merge-base --is-ancestor ${q(a)} ${q(b)}`).code === 0;
  const ancestors = locals.filter((b) => isAncestor(b, branch));
  const closest = ancestors.find((a) => ancestors.every((o) => o === a || isAncestor(o, a)));
  return closest ?? (ancestors.includes("main") ? "main" : ancestors[0] ?? "main");
}

export function worktreeDir(root: string, unitId: string): string {
  return join(root, ".ai-sdlc", "worktrees", unitId);
}

/**
 * Git hooks often load generated files that are never committed: husky's `.husky/_` (made by `husky install`). A
 * worktree is a checkout, so its hooks would fail on every commit (refine: "husky.sh: No such file or directory"),
 * and agents rightly refuse to skip hooks. Link whatever the main checkout's hooks folder has that the worktree lacks.
 */
export function linkHookHelpers(root: string, dir: string): string[] {
  const hooksPath = git(root, "config core.hooksPath").stdout.trim().replace(/\/$/, "");
  if (!hooksPath || isAbsolute(hooksPath) || !existsSync(join(root, hooksPath))) return [];
  const linked: string[] = [];
  for (const name of readdirSync(join(root, hooksPath))) {
    const rel = `${hooksPath}/${name}`;
    if (existsSync(join(dir, rel))) continue;
    mkdirSync(join(dir, hooksPath), { recursive: true });
    symlinkSync(join(root, rel), join(dir, rel));
    linked.push(rel);
  }
  return linked;
}

/** Fresh worktree for a unit at `base`, on branch `branch` (reset if it exists), with dependencies linked. */
export function addWorktree(root: string, dir: string, branch: string, base: string, extraLinks: string[] = []): void {
  if (existsSync(dir)) removeWorktree(root, dir);
  mkdirSync(join(root, ".ai-sdlc", "worktrees"), { recursive: true });
  must(root, `worktree add -f -B ${q(branch)} ${q(dir)} ${q(base)}`);
  const linked = [...linkDependencies(root, dir, extraLinks), ...linkHookHelpers(root, dir)];
  excludeFromGit(root, linked);
  mkdirSync(join(dir, ".ai-sdlc"), { recursive: true });
  writeFileSync(join(dir, ".ai-sdlc", "linked.json"), JSON.stringify(linked));
  carryLocalOverrides(root, dir);
  excludeFromGit(root, seedCaches(root, dir));
  excludeFromGit(root, TOOL_OUTPUT_DIRS);
}

/** Folders agents' tools write into the working directory (not the unit's work): the Playwright MCP's logs and snapshots. */
const TOOL_OUTPUT_DIRS = [".playwright-mcp"];

/**
 * Copy the tool caches the profiles name (.mypy_cache, .ruff_cache, .pytest_cache, .eslintcache) from the main
 * checkout into a new worktree, so its checks start warm. Measured on frontend-agent: mypy took 146 s in a fresh
 * worktree and 2.6 s with its cache copied in. Copied, not linked: units run in parallel, and processes writing one
 * shared cache could corrupt it. Returns the paths copied.
 */
export function seedCaches(root: string, dir: string, maxDepth = 4): string[] {
  const names = new Set(allProfiles().flatMap((p) => p.caches ?? []));
  if (!names.size) return [];
  const found: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: Dirent[];
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (names.has(e.name) && !e.isSymbolicLink()) { found.push(childRel); continue; }
      if (!e.isDirectory() || e.name === ".git" || e.name === ".ai-sdlc" || e.name === "node_modules" || e.name.startsWith(".venv") || depth >= maxDepth) continue;
      walk(childRel, depth + 1);
    }
  };
  walk("", 0);
  const copied: string[] = [];
  for (const rel of found) {
    const target = join(dir, rel);
    if (existsSync(target) || !existsSync(dirname(target))) continue;
    try { cpSync(join(root, rel), target, { recursive: true }); copied.push(rel); } catch { /* a cache is an optimisation */ }
  }
  return copied;
}

/**
 * Files the main checkout changes locally but hides from git (`git update-index --skip-worktree` or
 * `--assume-unchanged`), e.g. a machine-specific dependency pin. A worktree checks out the committed version, so
 * copy the local one in and hide it the same way: the unit runs in the same environment, and the override can
 * never be committed or merged. Returns the paths carried.
 */
export function carryLocalOverrides(root: string, dir: string): string[] {
  const hidden = git(root, "ls-files -v").stdout.split("\n").filter((l) => /^[Sh] /.test(l)).map((l) => l.slice(2));
  const carried: string[] = [];
  for (const p of hidden) {
    if (!existsSync(join(root, p))) continue;
    copyFileSync(join(root, p), join(dir, p));
    git(dir, `update-index --skip-worktree ${q(p)}`);
    carried.push(p);
  }
  return carried;
}

/** Symlinks are not matched by "dir/" ignore patterns; exclude linked paths explicitly (shared info/exclude). */
function excludeFromGit(root: string, paths: string[]): void {
  if (!paths.length) return;
  const common = must(root, "rev-parse --git-common-dir");
  const file = join(common.startsWith("/") ? common : join(root, common), "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = new Set(current.split("\n"));
  const add = paths.map((p) => `/${p}`).filter((l) => !lines.has(l));
  if (add.length) appendFileSync(file, (current.endsWith("\n") || !current ? "" : "\n") + add.join("\n") + "\n");
}

/**
 * Installed dependencies are not in git, so a fresh worktree has none. Symlink every node_modules
 * directory of the main checkout (root and per-app, e.g. apps/web/node_modules, tools/ai-sdlc/node_modules)
 * into the worktree, plus any extra paths from config (worktreeLinks). Returns the linked paths.
 */
export function linkDependencies(root: string, dir: string, extra: string[] = [], maxDepth = 4): string[] {
  const found: string[] = [];
  const envNames = new Set(["node_modules", ...allProfiles().flatMap((p) => p.environments ?? [])]);
  const walk = (rel: string, depth: number) => {
    const abs = join(root, rel);
    let entries: Dirent[];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (envNames.has(e.name)) { found.push(childRel); continue; }
      if (e.name === ".git" || e.name === ".ai-sdlc" || e.isSymbolicLink() || depth >= maxDepth) continue;
      walk(childRel, depth + 1);
    }
  };
  walk("", 0);
  const linked: string[] = [];
  for (const rel of [...found, ...extra]) {
    const target = join(dir, rel);
    if (!existsSync(join(root, rel)) || existsSync(target)) continue;
    if (!existsSync(dirname(target))) continue; // the folder is not part of this checkout
    symlinkSync(join(root, rel), target, "dir");
    linked.push(rel);
  }
  return linked;
}

export function removeWorktree(root: string, dir: string): void {
  // Unlink dependency symlinks first so removal can never reach the real directories behind them.
  const record = join(dir, ".ai-sdlc", "linked.json");
  if (existsSync(record)) {
    for (const rel of JSON.parse(readFileSync(record, "utf8")) as string[]) {
      try { if (lstatSync(join(dir, rel)).isSymbolicLink()) unlinkSync(join(dir, rel)); } catch { /* already gone */ }
    }
  }
  git(root, `worktree remove --force ${q(dir)}`);
  git(root, "worktree prune");
}

/** Stage and commit everything; returns false when there was nothing to commit. */
export function commitAll(cwd: string, message: string): boolean {
  must(cwd, "add -A");
  if (git(cwd, "diff --cached --quiet").code === 0) return false;
  must(cwd, `-c user.name=${q(process.env.GIT_AUTHOR_NAME ?? "ai-sdlc")} -c user.email=${q(process.env.GIT_AUTHOR_EMAIL ?? "ai-sdlc@localhost")} commit -q --no-verify -m ${q(message)}`);
  return true;
}

/** Files changed between `base` and HEAD, plus anything uncommitted or untracked. */
export function changedFiles(cwd: string, base: string): string[] {
  const committed = git(cwd, `diff --name-only ${q(base)} HEAD`).stdout;
  const working = git(cwd, "status --porcelain --untracked-files=all").stdout
    .split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ""));
  return [...new Set([...committed.split("\n").filter(Boolean), ...working])].sort();
}

export function diff(cwd: string, base: string, paths: string[] = []): string {
  return git(cwd, `diff ${q(base)} HEAD -- ${paths.map(q).join(" ")}`).stdout;
}

/** Merge a unit branch into the current branch of `root`. Aborts and returns the conflict on failure. */
/** A conventional commit message for merging a unit branch, so client commit hooks (commitlint) accept it. */
export function mergeMessage(unit: string, ticket: string, runId: string): string {
  return `chore(${unit}): merge ${ticket} ${runId}`;
}

export function mergeBranch(root: string, branch: string, message: string): { ok: boolean; output: string } {
  const r = git(root, `-c user.name=ai-sdlc -c user.email=ai-sdlc@localhost merge --no-ff --no-edit -m ${q(message)} ${q(branch)}`);
  if (r.code !== 0) {
    git(root, "merge --abort");
    return { ok: false, output: r.stdout + r.stderr };
  }
  return { ok: true, output: r.stdout };
}

/** Restore `paths` in the working tree to their content at `rev` (deleting files that did not exist there). */
export function restoreFrom(cwd: string, rev: string, paths: string[]): void {
  for (const p of paths) {
    const exists = git(cwd, `cat-file -e ${q(`${rev}:${p}`)}`).code === 0;
    if (exists) must(cwd, `checkout ${q(rev)} -- ${q(p)}`);
    else sh(`rm -f ${q(p)}`, { cwd });
  }
}
