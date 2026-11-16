// Usage and cost in Paperclip. Each agent run's cost goes to Paperclip's cost ledger on the ticket's issue (so the
// issue's cost summary and Paperclip's Costs pages show it), and a usage summary is posted on the issue when the PR
// opens: story points, cost, tokens and the Claude plan's 5-hour and weekly windows. Reporting never stops a run.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { planUsage, readEvents } from "../scripts/report.ts";
import { telemetryFile, type TelemetryEvent } from "./telemetry.ts";
import { writeFileEnsured } from "./util.ts";
import { WORKFLOW_MARK } from "./paperclip.ts";

/** The body of Paperclip's POST /companies/:id/cost-events. */
export interface CostEventBody {
  idempotencyKey: string; agentId: string; issueId: string; heartbeatRunId?: string;
  provider: "anthropic"; billingType: "subscription_included" | "metered_api"; costStatus: "estimated" | "reported";
  model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; costCents: string; occurredAt: string;
}

const cents = (usd: number) => (Math.max(0, usd) * 100).toFixed(7);

/**
 * Cost events for a ticket's agent runs: one per model per run. A run that reported a plan window ran on a
 * subscription, so its cost is the API-equivalent estimate of usage included in the plan.
 */
export function costEventsFor(events: TelemetryEvent[], ticket: string, o: { agentId: string; issueId: string; heartbeatRunId?: string }): CostEventBody[] {
  const out: CostEventBody[] = [];
  for (const e of events) {
    if (e.event !== "run" || e.ticket !== ticket || !e.run_id) continue;
    if (!(e.cost_usd ?? 0) && !(e.tokens_in ?? 0) && !(e.tokens_out ?? 0)) continue;
    const sub = Boolean(e.plan_window);
    const base = {
      agentId: o.agentId, issueId: o.issueId, ...(o.heartbeatRunId ? { heartbeatRunId: o.heartbeatRunId } : {}), provider: "anthropic" as const,
      billingType: sub ? "subscription_included" as const : "metered_api" as const, costStatus: sub ? "estimated" as const : "reported" as const,
      occurredAt: new Date(e.ended_at ?? e.started_at ?? Date.now()).toISOString(),
    };
    const key = (model: string) => `ai-sdlc:${e.run_id}:${e.agent ?? "agent"}:${e.unit ?? ""}:${e.attempt ?? 1}:${model}`;
    const models = Object.entries(e.models ?? {});
    if (models.length) {
      for (const [model, m] of models) out.push({ ...base, idempotencyKey: key(model), model, inputTokens: m.in + m.cache_write, cachedInputTokens: m.cache_read, outputTokens: m.out, costCents: cents(m.cost_usd) });
    } else {
      const cached = e.tokens_cache_read ?? 0;
      out.push({ ...base, idempotencyKey: key(e.model ?? "unknown"), model: e.model ?? "unknown", inputTokens: Math.max(0, (e.tokens_in ?? 0) - cached), cachedInputTokens: cached, outputTokens: e.tokens_out ?? 0, costCents: cents(e.cost_usd ?? 0) });
    }
  }
  return out;
}

const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

/** The usage summary for one ticket, in plain words, for a comment on its issue. */
export function usageComment(u: ReturnType<typeof planUsage>, ticket: string): string {
  const t = u.tickets.find((x) => x.ticket === ticket);
  if (!t) return `**Usage for ${ticket}**: no agent runs recorded.`;
  const sp = t.story_points;
  const sub = t.window_source !== "none" && t.window_source !== "estimated";
  const window = t.below_resolution
    ? `under 1% each (Claude Code reports the plan window in whole percents, so no single run registered)`
    : t.five_hour_pct !== undefined ? `${t.five_hour_pct.toFixed(1)}%${t.window_source === "measured" ? "" : ` (${t.window_source})`}` : "not reported (an API key has no plan window)";
  const list = [
    `- Cost: $${t.cost_usd.toFixed(2)}${sp ? ` ($${(t.cost_usd / sp).toFixed(2)} per story point)` : ""}${sub ? ". API-equivalent: on a subscription this is included in the plan, not billed" : ""}.`,
    `- Tokens: ${big(t.tokens_in)} in${t.tokens_cache_read ? ` (${big(t.tokens_cache_read)} from cache)` : ""}, ${big(t.tokens_out)} out, over ${t.runs} agent run(s), ${t.agent_minutes} agent-minutes.`,
    `- 5-hour window used by these runs: ${window}.`,
    t.five_hour_span ? `- The 5-hour window went ${t.five_hour_span.from}% → ${t.five_hour_span.to}% from the first run to the last. That is an upper bound: it includes any other Claude use on the account in that time.` : "",
    t.week_below_resolution ? "- Week (7-day) window: under 1%." : t.seven_day_pct !== undefined ? `- Week (7-day) window: ${t.seven_day_pct.toFixed(1)}%.` : "",
    u.per_point.points_per_window ? `- Projection: about ${u.per_point.points_per_window.toFixed(1)} story points per 5-hour window (from ${u.per_point.measured_tickets} measured tickets), if the plan is used only by the workflow.` : "",
  ].filter(Boolean);
  const lines = [
    `**Usage for ${ticket}**${sp ? ` (${sp} story points${t.estimate_hours ? `, estimated ${t.estimate_hours} h` : ""})` : ""}`,
    "", ...list, "",
    "Per-run costs are in this issue's cost summary. Full report: `ai-sdlc report --since 30d --jira`.",
  ];
  return lines.join("\n");
}

interface UsageRecord { costsPosted?: string[]; summaryPosted?: boolean }
const recordPath = (root: string, ticket: string) => join(root, ".ai-sdlc", "tickets", `${ticket}.usage.json`);

/**
 * Post the ticket's new cost events to Paperclip (once each), and with `summary` the usage comment (once). Never
 * throws: a refused event is skipped and tried again next time.
 */
export async function reportUsage(o: {
  root: string; api: { postCost(companyId: string, body: CostEventBody): Promise<void>; comment(issueId: string, body: string): Promise<void> };
  companyId: string; agentId: string; issueId: string; ticket: string; heartbeatRunId?: string; summary?: boolean; telemetryPath?: string;
}): Promise<{ posted: number; summary: boolean }> {
  const path = recordPath(o.root, o.ticket);
  const rec: UsageRecord = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const done = new Set(rec.costsPosted ?? []);
  const events = readEvents(o.telemetryPath ?? telemetryFile(o.root));
  let posted = 0;
  for (const body of costEventsFor(events, o.ticket, o)) {
    if (done.has(body.idempotencyKey)) continue;
    try { await o.api.postCost(o.companyId, body); done.add(body.idempotencyKey); posted++; } catch { /* tried again next time */ }
  }
  let summary = false;
  if (o.summary && !rec.summaryPosted) {
    try { await o.api.comment(o.issueId, `${WORKFLOW_MARK}\n` + usageComment(planUsage(events.filter((e) => e.ticket === o.ticket)), o.ticket)); summary = true; } catch { /* next time */ }
  }
  writeFileEnsured(path, JSON.stringify({ costsPosted: [...done], summaryPosted: rec.summaryPosted || summary }, null, 2) + "\n");
  return { posted, summary };
}
