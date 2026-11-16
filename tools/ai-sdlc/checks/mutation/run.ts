// Full mutation run before the PR: every generic mutant on lines changed since --base, plus the whole
// catalogue, against the tests changed since --base. Survivors fail the run.
// Usage: npm run mutation -- [--base main] [--limit N]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, repoRoot, WORKFLOW_ROOT } from "../../orchestrator/config.ts";
import { changedFiles, git } from "../../orchestrator/git.ts";
import { isTestFile, mutationGate } from "../../orchestrator/gates.ts";
import type { Brief, Unit } from "../../orchestrator/types.ts";

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const root = repoRoot();
const cfg = loadConfig(root);
const baseRef = flag("base") ?? "main";
const base = git(root, `merge-base ${baseRef} HEAD`).stdout.trim();
if (!base) { console.error(`cannot find merge base with ${baseRef}`); process.exit(1); }

const files = changedFiles(root, base).filter((f) => existsSync(join(root, f)));
const tests = files.filter((f) => isTestFile(f, cfg, []));
const impl = files.filter((f) => !isTestFile(f, cfg, []) && /\.(m?[jt]sx?)$/.test(f) && !f.startsWith("orchestrator/") && !f.startsWith("checks/"));
const unit: Unit = { id: "pre-push", kind: "service", name: "pre-push", slug: "pre-push", agent: "dev-backend", model: "", dependsOn: [], scope: ["**"], exposes: [], consumes: [], ir: { entities: [], services: [], screens: [] } };
const brief: Brief = { schema: "ai-sdlc.brief.v1", ticket: "", unit: unit.id, kind: "service", agent: "dev-backend", run_id: "", attempt: 1, base_commit: base, scope: ["**"], tests: cfg.tests.globs, issued_at: new Date().toISOString() };
const limit = flag("limit") ? Number(flag("limit")) : "all";
const r = mutationGate({ unit, brief, cwd: root, cfg, ledgerPath: join(root, ".ai-sdlc", "seen-red", "pre-push.json"), workflowRoot: WORKFLOW_ROOT }, tests, impl, limit);
console.log(r.output);
process.exit(r.pass ? 0 : 1);
