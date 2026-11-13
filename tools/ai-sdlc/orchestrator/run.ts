// The build loop: plan → brief → build → gates, unit by unit in dependency order, parallel within
// a level, one worktree per unit, three failed attempts then escalation, owed.yaml hand-offs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { cliHint, WORKFLOW_ROOT } from "./config.ts";
import { assembleBrief } from "./brief.ts";
import { defaultEscalator, type Escalator } from "./escalate.ts";
import { addWorktree, changedFiles, commitAll, currentBranch, git, headCommit, mergeBranch, mergeMessage, removeWorktree, restoreFrom, ticketBranch, unitBranch, worktreeDir } from "./git.ts";
import { gateReport, runUnitGates, scopeGate, checksGate, contractsGate } from "./gates.ts";
import { loadIr, validateIr } from "./ir.ts";
import { blockingFrom, formatOwed, loadOwed, mergeOwed, openFrom, openTo, parseOwed } from "./owed.ts";
import type { AgentRunner } from "./runner.ts";
import { emit } from "./telemetry.ts";
import type { AgentRunResult, GateResult, IR, Plan, Unit } from "./types.ts";
import { loadState, recordFailure, reopen, saveState, type TicketState, type UnitState } from "./attempts.ts";
import { newRunId, writeFileEnsured } from "./util.ts";

export interface BuildOptions {
  root: string;
  ticket: string;
  cfg: Config;
  runner: AgentRunner;
  escalator?: Escalator;
  runId?: string;
  workflowRoot?: string;
  log?: (msg: string) => void;
}

export interface BuildResult {
  status: "pass" | "escalated" | "incomplete";
  state: TicketState;
  summary: string;
}

export const planPath = (root: string, ticket: string) => join(root, "ir", `${ticket}.plan.json`);

export function loadPlan(root: string, ticket: string): Plan {
  const p = planPath(root, ticket);
  if (!existsSync(p)) throw new Error(`Plan not found: ${p}. Run: ${cliHint(`plan ${ticket}`, root)}`);
  return JSON.parse(readFileSync(p, "utf8")) as Plan;
}

/** Stage 1 gate: every contract in the plan exists on the branch, committed, byte-identical. */
export function contractsExistGate(root: string, plan: Plan): GateResult {
  const problems: string[] = [];
  for (const c of plan.contracts) {
    const full = join(root, c.path);
    if (!existsSync(full)) problems.push(`missing: ${c.path}`);
    else if (readFileSync(full, "utf8") !== c.content) problems.push(`differs from plan: ${c.path}`);
    else if (git(root, `ls-files --error-unmatch '${c.path}'`).code !== 0) problems.push(`not committed: ${c.path}`);
  }
  if (git(root, `diff --quiet HEAD -- contracts ir`).code !== 0) problems.push("uncommitted changes under contracts/ or ir/");
  return { name: "contracts-exist", pass: problems.length === 0, output: problems.length ? problems.join("\n") + `\nRun: ${cliHint(`plan ${plan.ticket}`, root)} and commit the result.` : `${plan.contracts.length} contracts present` };
}

export function readinessIssues(ir: IR): string[] {
  const issues = validateIr(ir).map((i) => `${i.path}: ${i.message}`);
  const open = ir.questions.filter((q) => !q.answer);
  if (open.length) issues.push(`${open.length} clarification question(s) unanswered; answer them in the IR (questions[].answer) and re-plan`);
  if (ir.unplaced.length) issues.push(`${ir.unplaced.length} unplaced section(s); place them or remove them with a reason before building`);
  return issues;
}

interface Attempt { unit: Unit; st: UnitState; attemptNo: number; model: string; dir: string; branch: string; base: string; res: AgentRunResult; gates: GateResult[]; editedOwed: string; started: string; ended: string }

export async function buildTicket(o: BuildOptions): Promise<BuildResult> {
  const { root, ticket, cfg, runner } = o;
  const log = o.log ?? ((m: string) => process.stderr.write(m + "\n"));
  const escalator = o.escalator ?? defaultEscalator;
  const runId = o.runId ?? newRunId();
  const workflowRoot = o.workflowRoot ?? WORKFLOW_ROOT;
  const tBranch = ticketBranch(cfg.branchPrefix, ticket);
  if (currentBranch(root) !== tBranch) throw new Error(`Check out ${tBranch} first (currently on ${currentBranch(root)}).`);

  const ir = loadIr(root, ticket);
  const ready = readinessIssues(ir);
  if (ready.length) throw new Error(`IR not ready to build:\n${ready.join("\n")}`);
  const plan = loadPlan(root, ticket);
  const gate = contractsExistGate(root, plan);
  if (!gate.pass) throw new Error(`Stage 1 gate failed; no dev agent starts until contracts exist:\n${gate.output}`);

  const state = loadState(root, plan);
  const owedPath = join(root, "owed.yaml");
  const known = new Set(plan.units.map((u) => u.id));
  const buildUnits = plan.units.filter((u) => u.kind !== "walk");
  const ledgerPath = join(root, ".ai-sdlc", "seen-red", `${ticket}.json`);
  if (cfg.preflight !== false && buildUnits.some((u) => state.units[u.id].status === "pending")) {
    const pf = preflight(root, tBranch, cfg);
    if (!pf.pass) throw new Error(`Preflight failed, so no agent was started: the full checks fail in a clean worktree at the base commit, before any change. This is the environment, not the ticket. Fix it, then run the build again.\n${pf.output}`);
    log(`✓ preflight: full checks pass in a clean worktree at ${headCommit(root).slice(0, 8)}`);
  }

  const escalate = async (unit: Unit, st: UnitState, reason: string) => {
    st.status = "escalated";
    st.escalation = await escalator({
      root, ticket, unit: unit.id, runId, reason, branch: unitBranch(tBranch, unit.id), telemetryFile: cfg.telemetry.file, cfg,
      attempts: st.history.map((h) => ({ attempt: h.attempt, report: h.report, agentSummary: h.agentSummary })),
    });
    log(`✗ ${unit.id} escalated: ${reason}`);
  };

  const attempt = async (unit: Unit): Promise<Attempt> => {
    const st = state.units[unit.id];
    st.runs++;
    const base = headCommit(root);
    const branch = unitBranch(tBranch, unit.id);
    const dir = worktreeDir(root, unit.id);
    addWorktree(root, dir, branch, base, cfg.worktreeLinks ?? []);
    const { markdown, json } = assembleBrief({ ir, plan, unit, cfg, root, runId, attempt: st.failures + 1, baseCommit: base, owed: loadOwed(owedPath), fixReport: st.fixReport });
    writeFileEnsured(join(dir, ".ai-sdlc", "brief.json"), JSON.stringify(json, null, 2) + "\n");
    writeFileEnsured(join(dir, ".ai-sdlc", "brief.md"), markdown);
    // Attempts past attemptsPerUnit run on the escalation model (a stronger one) before a person takes over.
    const extra = cfg.escalationModel?.attempts ?? 0;
    const model = st.failures >= cfg.attemptsPerUnit && cfg.escalationModel ? cfg.escalationModel.model : unit.model;
    log(`→ ${unit.id} (${unit.agent}, ${model}, attempt ${st.failures + 1}/${cfg.attemptsPerUnit + extra})`);
    const started = new Date().toISOString();
    const res = await runner.run({
      agent: unit.agent, prompt: markdown, cwd: dir, model, budgetUsd: cfg.budgetUsdPerRun,
      env: { AI_SDLC_RUN_ID: runId, AI_SDLC_TICKET: ticket, AI_SDLC_UNIT: unit.id, AI_SDLC_AGENT: unit.agent, AI_SDLC_ATTEMPT: String(st.failures + 1), AI_SDLC_BRIEF: join(dir, ".ai-sdlc", "brief.json"), AI_SDLC_TELEMETRY_FILE: join(root, cfg.telemetry.file) },
    });
    state.cost_usd += res.cost_usd;
    const editedOwed = existsSync(join(dir, "owed.yaml")) ? readFileSync(join(dir, "owed.yaml"), "utf8") : "[]";
    // owed.yaml is merged centrally; restore the unit's copy so branch merges never conflict on it.
    commitAll(dir, `chore(${unit.id}): work from ${runId}\n\nTicket: ${ticket}\nUnit: ${unit.id}\nRun: ${runId}`);
    restoreFrom(dir, base, ["owed.yaml"]);
    commitAll(dir, `chore(${unit.id}): owed.yaml is merged by the orchestrator\n\nTicket: ${ticket}\nUnit: ${unit.id}\nRun: ${runId}`);
    const gates = res.ok
      ? runUnitGates({ unit, brief: json, cwd: dir, cfg, ledgerPath, workflowRoot })
      : [{ name: "agent-run", pass: false, output: `The agent run did not complete: ${res.text.slice(0, 3000)}` }];
    return { unit, st, attemptNo: st.failures + 1, model, dir, branch, base, res, gates, editedOwed, started, ended: new Date().toISOString() };
  };

  const finalize = async (a: Attempt) => {
    const { unit, st } = a;
    const canonical = loadOwed(owedPath);
    const parsed = parseOwed(a.editedOwed);
    const merge = mergeOwed(canonical, parsed.entries, unit.id, known, runId);
    const owedGates: GateResult[] = [];
    const owedProblems = [...parsed.errors, ...merge.violations];
    owedGates.push({ name: "owed-valid", pass: owedProblems.length === 0, output: owedProblems.join("\n") || "ok" });
    const stillOwed = openTo(merge.merged, unit.id);
    owedGates.push({ name: "owed-delivered", pass: stillOwed.length === 0, output: stillOwed.length ? `You still owe:\n${stillOwed.map((e) => `  ${e.id} (from ${e.from}): ${e.note ?? e.contract ?? e.kind}`).join("\n")}\nDeliver it and set status: closed.` : "nothing owed" });
    let gates = [...a.gates, ...(a.gates.every((g) => g.pass) ? owedGates : [])];
    let pass = gates.every((g) => g.pass);

    if (pass) {
      const m = mergeBranch(root, a.branch, mergeMessage(unit.id, ticket, runId));
      if (!m.ok) { gates = [...gates, { name: "merge", pass: false, output: m.output }]; pass = false; }
    }

    let status: "pass" | "fail" | "escalated" | "blocked" = "fail";
    if (pass) {
      writeFileSync(owedPath, formatOwed(merge.merged));
      commitAll(root, `chore(owed): ${unit.id} ${merge.added.length} opened, ${merge.closed.length} closed\n\nTicket: ${ticket}\nRun: ${runId}`);
      st.fixReport = undefined;
      const waiting = blockingFrom(merge.merged, unit.id);
      // Providers that already passed must come back for any new hand-off (blocking or not).
      const reopenFor = [...waiting, ...merge.added.filter((e) => e.kind === "wiring")];
      if (waiting.length) {
        st.status = "blocked";
        status = "blocked";
        log(`… ${unit.id} blocked on ${waiting.map((w) => w.to).join(", ")}`);
      } else {
        st.status = "passed";
        status = "pass";
        st.gates = gates.map((g) => ({ name: g.name, pass: g.pass, output: g.output.slice(0, 1500) }));
        log(`✓ ${unit.id}`);
      }
      {
        for (const w of reopenFor) {
          const ps = state.units[w.to];
          if (ps && ps.status === "passed") {
            const capped = reopen(ps, `Another unit needs something from you (owed.yaml ${w.id}, from ${w.from}): ${w.note ?? ""} ${w.contract ?? ""}`.trim(), cfg.attemptsPerUnit);
            if (capped) await escalate(plan.units.find((u) => u.id === w.to)!, ps, "re-opened by owed.yaml more times than the attempt cap");
          }
        }
      }
      // Wake consumers whose entries are now all closed.
      for (const closed of merge.closed) {
        const cs = state.units[closed.from];
        if (cs?.status === "blocked" && blockingFrom(merge.merged, closed.from).length === 0) {
          reopen(cs, `Delivered by ${unit.id}: ${merge.closed.filter((c) => c.from === closed.from).map((c) => `${c.id} ${c.note ?? ""}`).join("; ")}. Finish the work that depended on it.`, cfg.attemptsPerUnit);
        }
      }
    } else {
      const report = gateReport(gates.filter((g) => !g.pass));
      const cap = cfg.attemptsPerUnit + (cfg.escalationModel?.attempts ?? 0);
      const capped = recordFailure(st, { attempt: a.attemptNo, run_id: runId, report, agentSummary: a.res.text.slice(0, 2000), cost_usd: a.res.cost_usd }, cap);
      log(`✗ ${unit.id} failed: ${gates.filter((g) => !g.pass).map((g) => g.name).join(", ")}`);
      // A gate whose own tool cannot run fails every attempt the same way: escalate now, as a setup problem.
      const setup = gates.find((g) => !g.pass && g.setup);
      if (capped) { await escalate(unit, st, cfg.escalationModel ? `${cfg.attemptsPerUnit} attempts on ${unit.model} and ${cfg.escalationModel.attempts} on ${cfg.escalationModel.model} failed` : `${cfg.attemptsPerUnit} attempts failed`); status = "escalated"; }
      else if (setup) { await escalate(unit, st, `setup problem: the ${setup.name} gate could not run its own tool (see the report). Fix the configuration, then reset the unit; more attempts would fail the same way`); status = "escalated"; }
    }
    await emit(root, {
      event: "run", run_id: runId, ticket, unit: unit.id, agent: unit.agent, model: a.model, attempt: a.attemptNo,
      started_at: a.started, ended_at: a.ended, status, tokens_in: a.res.tokens_in, tokens_out: a.res.tokens_out, cost_usd: a.res.cost_usd, cost_source: a.res.cost_source,
      output_ref: `branch:${a.branch}`, detail: { gates: gates.map((g) => ({ name: g.name, pass: g.pass })) },
    }, cfg.telemetry.file);
    removeWorktree(root, a.dir);
    saveState(root, state);
  };

  // Main loop.
  for (let guard = 0; guard < buildUnits.length * (cfg.attemptsPerUnit + (cfg.escalationModel?.attempts ?? 0) + 1) * 3; guard++) {
    if (state.cost_usd >= cfg.budgetUsdPerTicket) {
      for (const u of buildUnits) if (state.units[u.id].status === "pending" || state.units[u.id].status === "blocked") await escalate(u, state.units[u.id], `ticket budget of $${cfg.budgetUsdPerTicket} reached ($${state.cost_usd.toFixed(2)} spent)`);
      break;
    }
    const ready = buildUnits.filter((u) => state.units[u.id].status === "pending" && u.dependsOn.every((d) => state.units[d]?.status === "passed"));
    if (!ready.length) break;
    const batch = ready.slice(0, Math.max(1, cfg.concurrency));
    const attempts = await Promise.all(batch.map((u) => attempt(u)));
    for (const a of attempts) await finalize(a); // sequential: merges and owed.yaml writes
    saveState(root, state);
  }

  for (const u of buildUnits) {
    const st = state.units[u.id];
    if (st.status === "blocked") await escalate(u, st, `waiting on owed.yaml entries that were never closed: ${blockingFrom(loadOwed(owedPath), u.id).map((e) => e.id).join(", ")}`);
  }
  saveState(root, state);

  const counts = { passed: 0, escalated: 0, pending: 0, blocked: 0 } as Record<string, number>;
  for (const u of buildUnits) counts[state.units[u.id].status]++;
  const status = counts.passed === buildUnits.length ? "pass" : counts.escalated ? "escalated" : "incomplete";
  const lines = buildUnits.map((u) => {
    const st = state.units[u.id];
    const waitingOnEscalated = st.status === "pending" && u.dependsOn.some((d) => state.units[d]?.status === "escalated");
    return `${st.status.padEnd(9)} ${u.id}  runs=${st.runs} failures=${st.failures}${waitingOnEscalated ? "  (not started: a dependency escalated)" : ""}${st.escalation ? `  report=${st.escalation}` : ""}`;
  });
  return { status, state, summary: `${ticket}: ${status} (build agents $${state.cost_usd.toFixed(2)}; the PR shows the ticket's total)\n${lines.join("\n")}` };
}

/** Full checks in a fresh worktree at the ticket branch's HEAD, set up exactly like a unit's (links, overrides). */
export function preflight(root: string, tBranch: string, cfg: Config): GateResult {
  const dir = worktreeDir(root, "preflight");
  const branch = `${tBranch}--preflight`;
  const base = headCommit(root);
  addWorktree(root, dir, branch, base, cfg.worktreeLinks ?? []);
  try {
    // BASE_REF = this commit: the guards judge what a unit changes, and the preflight has changed nothing. Without it
    // they scan every tracked file and fail on what the repo already contains (refine's test mocks).
    return checksGate(dir, cfg.checks.full, "preflight", { BASE_REF: base });
  } finally {
    removeWorktree(root, dir);
    git(root, `branch -D '${branch}'`);
  }
}

/** Walk-unit gates: scope and checks only (e2e specs are red at base by construction). */
export function walkGates(dir: string, base: string, unit: Unit, cfg: Config, env?: Record<string, string>): GateResult[] {
  const files = changedFiles(dir, base);
  return [scopeGate(files, unit), contractsGate(files), checksGate(dir, cfg.checks.full, "checks", env)];
}
