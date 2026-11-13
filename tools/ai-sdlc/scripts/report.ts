// "Cost and cycle time per ticket this week" from the telemetry file sink, as a table or a static HTML
// dashboard. Usage: npm run report [-- --since 7d] [--html out.html]
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, repoRoot } from "../orchestrator/config.ts";
import { telemetryFile, type TelemetryEvent } from "../orchestrator/telemetry.ts";
import { writeFileEnsured } from "../orchestrator/util.ts";

export interface TicketRow { ticket: string; runs: number; passes: number; fails: number; escalations: number; cost_usd: number; tokens_in: number; tokens_out: number; first: string; last: string; cycle_hours: number }
export interface AgentRow { agent: string; runs: number; cost_usd: number; fail_rate: number }

export function parseSince(s: string, now = Date.now()): number {
  const m = s.match(/^(\d+)([hdw])$/);
  if (!m) return Date.parse(s);
  const ms = { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2] as "h" | "d" | "w"];
  return now - Number(m[1]) * ms;
}

export function aggregate(events: TelemetryEvent[], sinceMs: number) {
  const recent = events.filter((e) => Date.parse(e.ended_at ?? e.started_at ?? "") >= sinceMs);
  const tickets = new Map<string, TicketRow>();
  const agents = new Map<string, { runs: number; cost: number; fails: number }>();
  for (const e of recent) {
    if (e.event === "run" && e.agent) {
      const a = agents.get(e.agent) ?? { runs: 0, cost: 0, fails: 0 };
      a.runs++; a.cost += e.cost_usd ?? 0; if (e.status === "fail" || e.status === "escalated") a.fails++;
      agents.set(e.agent, a);
    }
    if (!e.ticket || (e.event !== "run" && e.event !== "escalation")) continue;
    const t = tickets.get(e.ticket) ?? { ticket: e.ticket, runs: 0, passes: 0, fails: 0, escalations: 0, cost_usd: 0, tokens_in: 0, tokens_out: 0, first: "9999", last: "", cycle_hours: 0 };
    if (e.event === "escalation") t.escalations++;
    else {
      t.runs++;
      if (e.status === "pass") t.passes++;
      if (e.status === "fail") t.fails++;
      t.cost_usd += e.cost_usd ?? 0;
      t.tokens_in += e.tokens_in ?? 0;
      t.tokens_out += e.tokens_out ?? 0;
    }
    const start = e.started_at ?? e.ended_at!;
    const end = e.ended_at ?? e.started_at!;
    if (start < t.first) t.first = start;
    if (end > t.last) t.last = end;
    tickets.set(e.ticket, t);
  }
  for (const t of tickets.values()) t.cycle_hours = (Date.parse(t.last) - Date.parse(t.first)) / 3600e3;
  return {
    tickets: [...tickets.values()].sort((a, b) => b.cost_usd - a.cost_usd),
    agents: [...agents.entries()].map(([agent, a]) => ({ agent, runs: a.runs, cost_usd: a.cost, fail_rate: a.runs ? a.fails / a.runs : 0 })).sort((a, b) => b.cost_usd - a.cost_usd),
    events: recent.length,
  };
}

export function readEvents(path: string): TelemetryEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function table(r: ReturnType<typeof aggregate>): string {
  const head = "ticket        runs  pass  fail  esc   cost($)   tokens(in/out)      cycle(h)";
  const rows = r.tickets.map((t) => `${t.ticket.padEnd(13)} ${String(t.runs).padStart(4)} ${String(t.passes).padStart(5)} ${String(t.fails).padStart(5)} ${String(t.escalations).padStart(4)} ${t.cost_usd.toFixed(2).padStart(9)}   ${`${t.tokens_in}/${t.tokens_out}`.padEnd(18)} ${t.cycle_hours.toFixed(1).padStart(8)}`);
  const agents = r.agents.map((a) => `  ${a.agent.padEnd(14)} runs=${a.runs} cost=$${a.cost_usd.toFixed(2)} fail-rate=${(a.fail_rate * 100).toFixed(0)}%`);
  return [head, ...rows, "", "by agent:", ...agents].join("\n");
}

export function html(r: ReturnType<typeof aggregate>, since: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const rows = r.tickets.map((t) => `<tr><td>${esc(t.ticket)}</td><td>${t.runs}</td><td>${t.passes}</td><td>${t.fails}</td><td>${t.escalations}</td><td>$${t.cost_usd.toFixed(2)}</td><td>${t.cycle_hours.toFixed(1)} h</td></tr>`).join("");
  const arows = r.agents.map((a) => `<tr><td>${esc(a.agent)}</td><td>${a.runs}</td><td>$${a.cost_usd.toFixed(2)}</td><td>${(a.fail_rate * 100).toFixed(0)}%</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent runs</title>
<style>:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e5e5e5}@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#999;--line:#333}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:24px 16px}
table{border-collapse:collapse;width:100%;margin:12px 0 32px}th,td{text-align:right;padding:6px 10px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:500}
.wrap{overflow-x:auto}</style></head><body>
<h1>Agent runs since ${esc(since)}</h1><p style="color:var(--muted)">${r.events} events · generated ${new Date().toISOString()}</p>
<h2>Per ticket: cost and cycle time</h2><div class="wrap"><table><tr><th>Ticket</th><th>Runs</th><th>Pass</th><th>Fail</th><th>Escalated</th><th>Cost</th><th>Cycle</th></tr>${rows}</table></div>
<h2>Per agent</h2><div class="wrap"><table><tr><th>Agent</th><th>Runs</th><th>Cost</th><th>Fail rate</th></tr>${arows}</table></div></body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const root = repoRoot();
  const since = flag("since") ?? "7d";
  const r = aggregate(readEvents(telemetryFile(root, loadConfig(root).telemetry.file)), parseSince(since));
  const out = flag("html");
  if (out) { writeFileEnsured(out, html(r, since)); console.log(`dashboard written: ${out}`); }
  else console.log(table(r));
}
