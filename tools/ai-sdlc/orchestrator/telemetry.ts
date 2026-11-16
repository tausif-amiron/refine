// Telemetry emitter. Schema: docs/TELEMETRY.md#event-schema.
// File sink always; OTLP/HTTP logs when OTEL_EXPORTER_OTLP_ENDPOINT is set. Never throws.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentRunResult, ModelUsage, PlanWindow } from "./types.ts";

export interface TelemetryEvent {
  schema?: "ai-sdlc.event.v1";
  event: "run" | "tool_call" | "session_end" | "escalation" | "gate" | "release" | "incident";
  run_id?: string;
  ticket?: string;
  unit?: string;
  agent?: string;
  model?: string;
  attempt?: number;
  started_at?: string;
  ended_at?: string;
  status?: "pass" | "fail" | "escalated" | "blocked" | "error" | "info";
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  cost_source?: "cli" | "sdk" | "unknown" | "fake";
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  models?: Record<string, ModelUsage>;
  plan_window?: PlanWindow;
  output_ref?: string;
  detail?: Record<string, unknown>;
}

/** The usage fields of a run event, from an agent's result (tokens, cost, cache split, models, plan window). */
export function usageFields(res: AgentRunResult): Pick<TelemetryEvent, "tokens_in" | "tokens_out" | "cost_usd" | "cost_source" | "tokens_cache_read" | "tokens_cache_write" | "models" | "plan_window"> {
  return {
    tokens_in: res.tokens_in, tokens_out: res.tokens_out, cost_usd: res.cost_usd, cost_source: res.cost_source,
    ...(res.tokens_cache_read !== undefined ? { tokens_cache_read: res.tokens_cache_read, tokens_cache_write: res.tokens_cache_write } : {}),
    ...(res.models ? { models: res.models } : {}),
    ...(res.plan_window ? { plan_window: res.plan_window } : {}),
  };
}

export function telemetryFile(root: string, configured = ".ai-sdlc/telemetry/events.jsonl"): string {
  const override = process.env.AI_SDLC_TELEMETRY_FILE;
  const p = override ?? configured;
  return isAbsolute(p) ? p : join(root, p);
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<TelemetryEvent> {
  const ctx: Partial<TelemetryEvent> = {};
  if (env.AI_SDLC_RUN_ID) ctx.run_id = env.AI_SDLC_RUN_ID;
  if (env.AI_SDLC_TICKET) ctx.ticket = env.AI_SDLC_TICKET;
  if (env.AI_SDLC_UNIT) ctx.unit = env.AI_SDLC_UNIT;
  if (env.AI_SDLC_AGENT) ctx.agent = env.AI_SDLC_AGENT;
  if (env.AI_SDLC_ATTEMPT) ctx.attempt = Number(env.AI_SDLC_ATTEMPT);
  return ctx;
}

export async function emit(root: string, ev: TelemetryEvent, file?: string): Promise<void> {
  const record = { schema: "ai-sdlc.event.v1" as const, ...ev };
  const now = new Date().toISOString();
  if (!record.ended_at && !record.started_at) record.ended_at = now;
  try {
    const path = telemetryFile(root, file);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch (e) {
    process.stderr.write(`telemetry: file sink failed: ${String(e)}\n`);
  }
  await exportOtlp(record).catch((e) => process.stderr.write(`telemetry: otlp export failed: ${String(e)}\n`));
}

/** Map an event to an OTLP/HTTP JSON logs payload. */
export function toOtlp(ev: TelemetryEvent & { schema: string }) {
  const attr = (key: string, v: unknown) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "number") return { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } };
    if (typeof v === "boolean") return { key, value: { boolValue: v } };
    return { key, value: { stringValue: typeof v === "string" ? v : JSON.stringify(v) } };
  };
  const { detail, ...flat } = ev;
  const attributes = Object.entries({ ...flat, detail }).map(([k, v]) => attr(`ai_sdlc.${k}`, v)).filter(Boolean);
  const ts = Date.parse(ev.ended_at ?? ev.started_at ?? new Date().toISOString()) * 1e6;
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "ai-sdlc" } }] },
      scopeLogs: [{
        scope: { name: "ai-sdlc.telemetry", version: "1" },
        logRecords: [{
          timeUnixNano: String(ts),
          severityText: ev.status === "fail" || ev.status === "error" || ev.status === "escalated" ? "WARN" : "INFO",
          body: { stringValue: `${ev.event} ${ev.agent ?? ""} ${ev.unit ?? ""} ${ev.status ?? ""}`.trim() },
          attributes,
        }],
      }],
    }],
  };
}

async function exportOtlp(ev: TelemetryEvent & { schema: string }): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) headers[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  const url = endpoint.replace(/\/$/, "") + "/v1/logs";
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(toOtlp(ev)), signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
