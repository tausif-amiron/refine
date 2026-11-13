// Per-ticket unit state, persisted so a run can resume and QA can feed fix briefs back.
// Attempts count failures only: a unit re-queued because it owes something is new work, not a failure.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "./types.ts";
import { writeFileEnsured } from "./util.ts";

export type UnitStatus = "pending" | "passed" | "blocked" | "escalated";

export interface AttemptRecord { attempt: number; run_id: string; report: string; agentSummary?: string; cost_usd: number }

export interface UnitState {
  status: UnitStatus;
  failures: number;        // failed attempts so far (cap: attemptsPerUnit)
  reopens: number;         // times re-queued by owed.yaml (cap: attemptsPerUnit)
  runs: number;
  fixReport?: string;
  history: AttemptRecord[];
  escalation?: string;     // path to escalation report
  /** Gate results of the attempt that passed (facts QA and the PR can cite). */
  gates?: { name: string; pass: boolean; output: string }[];
  /** Set when a developer finished the unit on its branch after an escalation (`ai-sdlc gates`). */
  finishedBy?: "developer";
}

export interface TicketState {
  schema: "ai-sdlc.state.v1";
  ticket: string;
  plan_ir_hash: string;
  cost_usd: number;
  units: Record<string, UnitState>;
}

export const statePath = (root: string, ticket: string) => join(root, ".ai-sdlc", "state", `${ticket}.json`);

export function loadState(root: string, plan: Plan): TicketState {
  const p = statePath(root, plan.ticket);
  if (existsSync(p)) {
    const s = JSON.parse(readFileSync(p, "utf8")) as TicketState;
    if (s.plan_ir_hash === plan.ir_hash) {
      for (const u of plan.units) s.units[u.id] ??= freshUnit();
      return s;
    }
  }
  return { schema: "ai-sdlc.state.v1", ticket: plan.ticket, plan_ir_hash: plan.ir_hash, cost_usd: 0, units: Object.fromEntries(plan.units.map((u) => [u.id, freshUnit()])) };
}

export function saveState(root: string, s: TicketState): void {
  writeFileEnsured(statePath(root, s.ticket), JSON.stringify(s, null, 2) + "\n");
}

export const freshUnit = (): UnitState => ({ status: "pending", failures: 0, reopens: 0, runs: 0, history: [] });

/** Record a failed attempt. Returns true when the cap is reached (caller escalates). */
export function recordFailure(st: UnitState, rec: AttemptRecord, cap: number): boolean {
  st.failures++;
  st.history.push(rec);
  st.fixReport = rec.report;
  if (st.failures >= cap) { st.status = "escalated"; return true; }
  st.status = "pending";
  return false;
}

/** Re-queue a unit because of an owed entry or a QA fix brief. Returns true when the reopen cap is hit. */
export function reopen(st: UnitState, why: string, cap: number): boolean {
  st.reopens++;
  st.fixReport = why;
  if (st.reopens > cap) { st.status = "escalated"; return true; }
  st.status = "pending";
  return false;
}
