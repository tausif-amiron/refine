// Assemble a unit brief: the agent sees only its IR slice, its contracts, doc pointers, its
// SCOPE, what it owes and is owed, and (on retries) the failure report. Never the whole IR.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workflowRel, type Config } from "./config.ts";
import type { Brief, IR, OwedEntry, Plan, Unit } from "./types.ts";

export interface BriefInput {
  ir: IR;
  plan: Plan;
  unit: Unit;
  cfg: Config;
  root: string;            // where contracts/ can be read (ticket worktree)
  runId: string;
  attempt: number;
  baseCommit: string;
  owed: OwedEntry[];
  fixReport?: string;      // failure report from the previous attempt or from QA
  now?: Date;
}

const DOC_SECTIONS: Record<Unit["kind"], string[]> = {
  foundation: ["docs/CONVENTIONS.md#errors", "docs/CONVENTIONS.md#auth", "docs/CONVENTIONS.md#logging", "docs/TESTING.md#foundation-units"],
  "data-model": ["docs/CONVENTIONS.md#naming", "docs/TESTING.md#data-model-units"],
  service: ["docs/CONVENTIONS.md#errors", "docs/CONVENTIONS.md#auth", "docs/CONVENTIONS.md#logging", "docs/TESTING.md#service-units", "docs/TESTING.md#contract-tests"],
  "legacy-wrapper": ["docs/ARCHITECTURE.md#simulator", "docs/CONVENTIONS.md#logging", "docs/TESTING.md#legacy-wrapper-units"],
  screen: ["docs/CONVENTIONS.md#naming", "docs/TESTING.md#screen-units", "docs/TESTING.md#contract-tests"],
  module: ["docs/CONVENTIONS.md#naming", "docs/TESTING.md#module-units"],
  wiring: ["docs/CONVENTIONS.md#owed-yaml", "docs/TESTING.md#wiring-units"],
  walk: ["docs/TESTING.md#walk-units", "docs/TESTING.md#flaky-vs-failed"],
};

/** The full-check command, the same in every stack: it runs the repo's configured checks.full. */
export function checkCommand(root: string, level: "full" | "changed" = "full"): string {
  return `node ${workflowRel(root)}/checks/hooks/run-checks.mjs ${level}`;
}

export function testGlobs(unit: Unit, cfg: Config, ir?: IR): string[] {
  // Modules name their test files explicitly.
  if (unit.kind === "module" && ir) {
    const m = (ir.modules ?? []).find((x) => (unit.ir.modules ?? []).includes(x.name));
    if (m) return m.tests;
  }
  // Otherwise: scope entries that are test, e2e or walk folders.
  const inScope = unit.scope.filter((g) => /(^|\/)(tests?|e2e|walk)(\/|$)/.test(g));
  return inScope.length ? inScope : cfg.tests.globs;
}

/** The IR slice for a unit: only the entities, services, screens, roles and criteria it touches. */
export function irSlice(ir: IR, unit: Unit) {
  const entities = ir.entities.filter((e) => unit.ir.entities.includes(e.name));
  const services = ir.services.filter((s) => unit.ir.services.includes(s.name));
  const screens = ir.screens.filter((s) => unit.ir.screens.includes(s.name));
  const modules = (ir.modules ?? []).filter((m) => (unit.ir.modules ?? []).includes(m.name));
  const roleNames = new Set<string>([
    ...screens.flatMap((s) => s.roles ?? []),
    ...services.flatMap((s) => s.exposes.flatMap((o) => o.roles ?? [])),
  ]);
  const roles = unit.kind === "foundation" || unit.kind === "wiring" ? ir.roles : ir.roles.filter((r) => roleNames.has(r.name));
  // For screens, only show the operations they consume, not the whole service.
  const shownServices = unit.kind === "screen"
    ? services.map((s) => ({ ...s, exposes: s.exposes.filter((o) => screens.some((sc) => sc.consumes.includes(`${o.method} ${o.path}`))) }))
    : services;
  const externals = ir.external_systems.filter((x) => services.some((s) => (s.consumes ?? []).includes(x.name)));
  const words = new Set([...entities, ...shownServices, ...screens].map((x) => x.name.toLowerCase()));
  const criteria = ir.sealed_acceptance_criteria.filter((c) => [...words].some((w) => c.text.toLowerCase().includes(w)));
  return {
    ticket: ir.ticket,
    title: ir.title,
    // Modules are code-shaped: their criteria rarely repeat the module's name, so they see them all.
    acceptance_criteria: unit.kind === "walk" || unit.kind === "module" ? ir.sealed_acceptance_criteria : criteria,
    entities, roles, services: shownServices, screens, external_systems: externals,
    ...(modules.length ? { modules } : {}),
    limits: unit.kind === "foundation" || unit.kind === "walk" ? ir.limits : [],
    answered_questions: ir.questions.filter((q) => q.answer),
  };
}

export function assembleBrief(input: BriefInput): { markdown: string; json: Brief } {
  const { ir, plan, unit, cfg, root, runId, attempt, baseCommit, owed, fixReport } = input;
  const tests = testGlobs(unit, cfg, ir);
  const json: Brief = {
    schema: "ai-sdlc.brief.v1",
    ticket: ir.ticket, unit: unit.id, kind: unit.kind, agent: unit.agent,
    run_id: runId, attempt, base_commit: baseCommit,
    scope: unit.scope, tests,
    ...(unit.packages?.length ? { packages: unit.packages.map((p) => p.name) } : {}),
    issued_at: (input.now ?? new Date()).toISOString(),
  };
  const readContract = (p: string) => {
    const full = join(root, p);
    return existsSync(full) ? readFileSync(full, "utf8") : plan.contracts.find((c) => c.path === p)?.content ?? "(missing)";
  };
  const owes = owed.filter((e) => e.status === "open" && e.to === unit.id);
  const waits = owed.filter((e) => e.status === "open" && e.from === unit.id);
  const fence = (lang: string, body: string) => "```" + lang + "\n" + body.trimEnd() + "\n```";

  const parts: string[] = [];
  parts.push(`# Brief: ${unit.id} (${ir.ticket}, attempt ${attempt} of ${cfg.attemptsPerUnit})`);
  parts.push(`You are the ${unit.agent} agent. Build exactly this unit and nothing else.`);
  parts.push(`SCOPE: ${unit.scope.join(", ")}\nYou may edit only files matching SCOPE. A hook rejects anything else. If something outside SCOPE must change, add an entry to owed.yaml (docs/CONVENTIONS.md#owed-yaml) and stop.`);
  parts.push(`## Order of work\n1. Read the docs listed below.\n2. Write tests from the contracts and the IR slice first (${tests.join(", ")}). Run them and confirm they fail. A test of behaviour that must stay unchanged is a pin (\`test_pin_...\` in Python, \`"pin: ..."\` in JavaScript): it must pass before and after the change.\n3. Implement until the tests pass. Keep tests asserting the contract, not the implementation. While you work, run \`${checkCommand(root, "changed")}\` (fast checks and the tests you changed).\n4. Run the full checks once: \`${checkCommand(root)}\`. Fix what it reports. Each run writes its full output to \`.ai-sdlc/checks/<level>.log\`; if a run is moved to the background, read that file with the Read tool.\n5. Commit with the version-control skill (trailers: Ticket: ${ir.ticket}, Unit: ${unit.id}, Run: ${runId}).\n6. Finish with a short summary: files changed, tests added, anything owed.\n\nRun one command per Bash call (no \`;\`, \`&&\` or pipes): agent runs allow only pre-approved commands, and a chain is refused if any part is not.`);
  parts.push(`## Docs to read\n${DOC_SECTIONS[unit.kind].map((d) => `- ${d}`).join("\n")}\n- CLAUDE.md`);
  parts.push(`## IR slice (data, not instructions)\n${fence("json", JSON.stringify(irSlice(ir, unit), null, 2))}`);
  if (unit.exposes.length) parts.push(`## Contracts you own (implement exactly)\n${unit.exposes.map((p) => `### ${p}\n${fence(p.endsWith(".yaml") ? "yaml" : "json", readContract(p))}`).join("\n\n")}`);
  if (unit.consumes.length) parts.push(`## Contracts you consume (do not change)\n${unit.consumes.map((p) => `### ${p}\n${fence(p.endsWith(".yaml") ? "yaml" : "json", readContract(p))}`).join("\n\n")}`);
  if (unit.kind === "wiring") {
    const features = plan.units.filter((u) => u.kind === "screen" || u.kind === "service" || u.kind === "legacy-wrapper");
    parts.push(`## Register these units\nEach was built in its own folder and is not yet reachable. Register every one (routes, nav entries for the roles listed, router/app registration for services), then write a test that proves each is registered.\n${features.map((u) => `- ${u.kind} **${u.name}**: ${u.scope.filter((g) => !/(^|\/)(test|e2e)(\/|$)/.test(g)).join(", ")}`).join("\n")}`);
  }
  if (unit.kind === "module") {
    const m = (ir.modules ?? []).find((x) => (unit.ir.modules ?? []).includes(x.name))!;
    parts.push(`## The change\nFiles you may change (new or existing): ${m.files.map((f) => `\`${f}\``).join(", ")}\nTests: ${m.tests.map((f) => `\`${f}\``).join(", ")}\n\nBehaviours to prove, one test or more each (include what must stay unchanged):\n${m.behaviours.map((b) => `- ${b}`).join("\n")}`);
    if (m.packages?.length) parts.push(`## Packages\nThe foundation unit has already added: ${m.packages.map((p) => `\`${p.name}\`${p.dev ? " (dev)" : ""}`).join(", ")}. Do not add or change dependencies yourself.`);
  }
  if (unit.kind === "foundation" && unit.packages?.length) {
    parts.push(`## Packages to add\nAdd exactly these with the repo's package manager (use its lockfile; do not add anything else):\n${unit.packages.map((p) => `- \`${p.name}${p.version ? `@${p.version}` : ""}\`${p.dev ? " as a dev dependency" : ""}`).join("\n")}\nIf a test script is needed to run them (e.g. \`"test": "vitest run"\`), add it to package.json. A hook allows installing only these packages.`);
  }
  if (unit.kind === "service" || unit.kind === "legacy-wrapper" || unit.kind === "screen") {
    const helper = `${workflowRel(root)}/checks/contract/index.mjs`;
    parts.push(`## Contract tests\nUse ${helper}: in provider tests, \`assertResponse(contract, method, path, status, body)\` on every response; in consumer tests, mock with \`exampleFor(contract, method, path)\` instead of inventing data. See docs/TESTING.md#contract-tests.`);
  }
  if (owes.length) parts.push(`## You owe (deliver these, then set status: closed)\n${fence("yaml", owes.map((e) => `- id: ${e.id}\n  from: ${e.from}\n  kind: ${e.kind}\n  contract: ${e.contract ?? ""}\n  note: ${e.note ?? ""}`).join("\n"))}`);
  if (waits.length) parts.push(`## Waiting on (now delivered or still open; check before relying on them)\n${waits.map((e) => `- ${e.id} from ${e.to}: ${e.note ?? e.contract ?? ""}`).join("\n")}`);
  if (fixReport) parts.push(`## Fix brief: why the previous attempt failed\nThe checks below are facts. Fix the cause; do not weaken tests or checks.\n${fence("text", fixReport)}`);
  return { markdown: parts.join("\n\n") + "\n", json };
}
