// QA phase: integration and contract checks (scripts), then the QA agent's walk (UI walk as a new user,
// API walk from contracts only). Failures become fix briefs to the owning unit; each counts as a failed
// attempt for that unit, so the three-attempt cap holds across build and QA.
import { join } from "node:path";
import type { Config } from "./config.ts";
import { assembleBrief } from "./brief.ts";
import { defaultEscalator, type Escalator } from "./escalate.ts";
import { addWorktree, commitAll, currentBranch, headCommit, mergeBranch, mergeMessage, removeWorktree, ticketBranch, unitBranch, worktreeDir } from "./git.ts";
import { checksGate, gateReport } from "./gates.ts";
import { loadIr } from "./ir.ts";
import { loadOwed } from "./owed.ts";
import { buildTicket, loadPlan, walkGates } from "./run.ts";
import type { AgentRunner } from "./runner.ts";
import { loadState, recordFailure, saveState } from "./attempts.ts";
import { startServices, type RunningServices } from "./services.ts";
import type { AgentRunResult, GateResult } from "./types.ts";
import { emit } from "./telemetry.ts";
import { extractJson, newRunId, writeFileEnsured } from "./util.ts";

export interface QaVerdict {
  /** pass: verified; fail: found defects (each assigned to a unit); blocked: could not verify (tools, environment). */
  status: "pass" | "fail" | "blocked";
  blocked_reason?: string;
  flaky: { test: string; note?: string }[];
  failures: { unit: string; summary: string; fix_brief: string }[];
}

export function parseVerdict(text: string, knownUnits: Set<string>): { verdict?: QaVerdict; error?: string } {
  let v: QaVerdict;
  try { v = extractJson<QaVerdict>(text); } catch (e) { return { error: String(e) }; }
  if (v.status !== "pass" && v.status !== "fail" && v.status !== "blocked") return { error: `status must be pass, fail or blocked (got ${String(v.status)})` };
  v.flaky = Array.isArray(v.flaky) ? v.flaky : [];
  v.failures = Array.isArray(v.failures) ? v.failures : [];
  const unknown = v.failures.filter((f) => !knownUnits.has(f.unit));
  if (unknown.length) return { error: `failures name unknown units: ${unknown.map((f) => f.unit).join(", ")}` };
  if (v.status === "pass" && v.failures.length) return { error: "status pass with failures listed" };
  if (v.status === "fail" && !v.failures.length) return { error: "status fail with no failures listed" };
  if (v.status === "blocked" && v.failures.length) return { error: "status blocked with failures listed; report defects as fail, inability to verify as blocked" };
  return { verdict: v };
}

export interface QaOptions {
  root: string; ticket: string; cfg: Config; runner: AgentRunner; escalator?: Escalator; log?: (m: string) => void;
}

export async function qaTicket(o: QaOptions): Promise<{ status: "pass" | "escalated" | "incomplete" | "blocked"; reportPath: string; summary: string }> {
  const { root, ticket, cfg, runner } = o;
  const log = o.log ?? ((m: string) => process.stderr.write(m + "\n"));
  const runId = newRunId();
  const ir = loadIr(root, ticket);
  const plan = loadPlan(root, ticket);
  const walk = plan.units.find((u) => u.kind === "walk")!;
  const known = new Set(plan.units.filter((u) => u.kind !== "walk").map((u) => u.id));
  const reportPath = join(root, ".ai-sdlc", "reports", ticket, "qa.md");
  const tBranch = ticketBranch(cfg.branchPrefix, ticket);
  if (currentBranch(root) !== tBranch) throw new Error(`Check out ${tBranch} first.`);
  const sections: string[] = [`# QA report: ${ticket}`, ""];

  for (let round = 1; round <= cfg.attemptsPerUnit; round++) {
    let state = loadState(root, plan);
    const notPassed = plan.units.filter((u) => u.kind !== "walk" && state.units[u.id].status !== "passed");
    if (notPassed.length) {
      const b = await buildTicket({ root, ticket, cfg, runner, escalator: o.escalator, runId, log });
      if (b.status !== "pass") { sections.push(`## Round ${round}: build did not pass\n\`\`\`\n${b.summary}\n\`\`\``); writeFileEnsured(reportPath, sections.join("\n")); return { status: b.status, reportPath, summary: b.summary }; }
      state = loadState(root, plan); // the build saved its progress; never overwrite it with a stale copy
    }

    // Start the simulator and the app (config: services); they stay up for the checks and the walk.
    let services: RunningServices;
    try {
      const needsSimulator = plan.units.some((u) => u.kind === "legacy-wrapper");
      const specs = (cfg.services ?? []).filter((s) => s.name !== "simulator" || needsSimulator);
      services = await startServices(root, specs, join(root, ".ai-sdlc", "reports", ticket, "services"));
    } catch (e) {
      sections.push(`## Round ${round}: services did not start`, "```", String(e instanceof Error ? e.message : e).slice(-6000), "```", "## Result: ESCALATED (environment)");
      writeFileEnsured(reportPath, sections.join("\n") + "\n");
      return { status: "escalated", reportPath, summary: "QA could not start the app or simulator; see the report" };
    }
    if (services.started.length || services.reused.length) sections.push(`Services: started ${services.started.join(", ") || "none"}; reused ${services.reused.join(", ") || "none"} (${Object.entries(services.env).map(([k, v]) => `${k}=${v}`).join(", ")})`);
    const ws = state.units[walk.id];
    let integration: GateResult, res: AgentRunResult, gates: GateResult[], dir: string, branch: string, base: string, started: string;
    try {
    integration = checksGate(root, [...cfg.checks.contract, ...cfg.checks.integration], "integration", services.env);
    sections.push(`## Round ${round}`, `### Integration and contract checks: ${integration.pass ? "PASS" : "FAIL"}`, "```", integration.output.slice(-6000), "```");
    if (!cfg.checks.integration.length) sections.push("No integration checks are configured (checks.integration is empty); only the contract check above ran.");

    // Walk: the QA agent in its own worktree.
    base = headCommit(root);
    dir = worktreeDir(root, walk.id);
    branch = unitBranch(tBranch, walk.id);
    addWorktree(root, dir, branch, base, cfg.worktreeLinks ?? []);
    const { markdown, json } = assembleBrief({ ir, plan, unit: walk, cfg, root, runId, attempt: round, baseCommit: base, owed: loadOwed(join(root, "owed.yaml")), fixReport: ws.fixReport });
    writeFileEnsured(join(dir, ".ai-sdlc", "brief.json"), JSON.stringify(json, null, 2) + "\n");
    const buildFacts = plan.units.filter((u) => u.kind !== "walk" && state.units[u.id].gates?.length).map((u) =>
      `${u.id}:\n${state.units[u.id].gates!.filter((g) => ["tests-changed", "seen-red", "mutation", "lint-new"].includes(g.name)).map((g) => `  [${g.pass ? "PASS" : "FAIL"}] ${g.name}: ${g.output.split("\n")[0]}`).join("\n")}`).join("\n");
    const prompt = `${markdown}\n## Build gates (facts from the build; cite them, do not call them unproven)\n\`\`\`\n${buildFacts || "none recorded"}\n\`\`\`\n## QA instructions\nRunning services (use these URLs): ${Object.entries(services.env).map(([k, v]) => `${k}=${v}`).join(", ") || "none configured"}\nIntegration and contract checks (facts):\n\`\`\`\n${integration.output.slice(-4000)}\n\`\`\`\nUnits you may assign failures to: ${[...known].join(", ")}.\nFollow .claude/agents/qa.md. End with the verdict JSON.`;
    started = new Date().toISOString();
    ws.runs++;
    res = await runner.run({ agent: "qa", prompt, cwd: dir, model: walk.model, budgetUsd: cfg.budgetUsdPerRun, env: { ...services.env, AI_SDLC_RUN_ID: runId, AI_SDLC_TICKET: ticket, AI_SDLC_UNIT: walk.id, AI_SDLC_AGENT: "qa", AI_SDLC_ATTEMPT: String(round), AI_SDLC_BRIEF: join(dir, ".ai-sdlc", "brief.json"), AI_SDLC_TELEMETRY_FILE: join(root, cfg.telemetry.file) } });
    commitAll(dir, `test(${walk.id}): walk specs from ${runId}\n\nTicket: ${ticket}\nUnit: ${walk.id}\nRun: ${runId}`);
    gates = walkGates(dir, base, walk, cfg, services.env);
    } finally {
      await services.stop();
    }
    const parsed = parseVerdict(res.text, known);
    sections.push(`### Walk gates`, "```", gateReport(gates), "```", `### QA agent report (verdict parsed by code)`, res.text.slice(0, 20000));
    await emit(root, { event: "run", run_id: runId, ticket, unit: walk.id, agent: "qa", model: walk.model, attempt: round, started_at: started, ended_at: new Date().toISOString(), status: parsed.verdict?.status === "pass" && gates.every((g) => g.pass) && integration.pass ? "pass" : "fail", tokens_in: res.tokens_in, tokens_out: res.tokens_out, cost_usd: res.cost_usd, cost_source: res.cost_source }, cfg.telemetry.file);

    const walkOk = gates.every((g) => g.pass);
    if (walkOk && integration.pass && parsed.verdict?.status === "pass") {
      const m = mergeBranch(root, branch, mergeMessage(walk.id, ticket, runId));
      removeWorktree(root, dir);
      if (m.ok) {
        ws.status = "passed"; saveState(root, state);
        if (parsed.verdict.flaky.length) sections.push(`### Flaky (reported, not blocking)\n${parsed.verdict.flaky.map((f) => `- ${f.test}${f.note ? `: ${f.note}` : ""}`).join("\n")}`);
        sections.push(`## Result: PASS`);
        writeFileEnsured(reportPath, sections.join("\n") + "\n");
        return { status: "pass", reportPath, summary: `QA passed in round ${round}` };
      }
      sections.push("### Merge of walk specs failed", "```", m.output, "```");
    }
    removeWorktree(root, dir);

    // QA could not verify (a tool was refused, the environment is broken): that is not a defect in any unit,
    // so no unit is charged an attempt. Escalate the QA environment to a person instead.
    if (parsed.verdict?.status === "blocked") {
      const why = parsed.verdict.blocked_reason ?? "the QA agent could not verify the ticket";
      sections.push(`## Result: BLOCKED (QA could not verify; no unit was charged)`, why);
      writeFileEnsured(reportPath, sections.join("\n") + "\n");
      saveState(root, state);
      await (o.escalator ?? defaultEscalator)({ root, ticket, unit: walk.id, runId, reason: `QA blocked: ${why}`, branch: tBranch, telemetryFile: cfg.telemetry.file, attempts: [{ attempt: round, report: res.text.slice(0, 4000) }] });
      return { status: "blocked", reportPath, summary: `QA blocked in round ${round}: ${why}` };
    }

    // Route failures back to their units as fix briefs.
    if (!parsed.verdict) {
      const capped = recordFailure(ws, { attempt: round, run_id: runId, report: `QA verdict could not be parsed: ${parsed.error}`, cost_usd: res.cost_usd }, cfg.attemptsPerUnit);
      if (capped) { saveState(root, state); break; }
    } else if (!walkOk) {
      const capped = recordFailure(ws, { attempt: round, run_id: runId, report: gateReport(gates.filter((g) => !g.pass)), cost_usd: res.cost_usd }, cfg.attemptsPerUnit);
      if (capped) { saveState(root, state); break; }
    }
    for (const f of parsed.verdict?.failures ?? []) {
      const st = state.units[f.unit];
      const capped = recordFailure(st, { attempt: st.failures + 1, run_id: runId, report: `QA found: ${f.summary}\n\nFix brief:\n${f.fix_brief}`, cost_usd: 0 }, cfg.attemptsPerUnit);
      log(`QA → fix brief for ${f.unit}${capped ? " (cap reached, escalating)" : ""}`);
      if (capped) {
        st.escalation = await (o.escalator ?? defaultEscalator)({ root, ticket, unit: f.unit, runId, reason: `QA failures after ${cfg.attemptsPerUnit} attempts`, branch: tBranch, telemetryFile: cfg.telemetry.file, attempts: st.history.map((h) => ({ attempt: h.attempt, report: h.report, agentSummary: h.agentSummary })) });
      }
    }
    if (!integration.pass && !(parsed.verdict?.failures.length)) {
      sections.push("Integration checks failed and the QA agent assigned no unit; escalating to a developer.");
      saveState(root, state);
      break;
    }
    saveState(root, state);
  }
  sections.push(`## Result: ESCALATED`);
  writeFileEnsured(reportPath, sections.join("\n") + "\n");
  return { status: "escalated", reportPath, summary: "QA did not pass within the attempt cap" };
}
