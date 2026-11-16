// "Cost and cycle time per ticket this week" from the telemetry file sink, as a table or a static HTML
// dashboard. Usage: npm run report [-- --since 7d] [--html out.html]
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, repoRoot } from "../orchestrator/config.ts";
import { telemetryFile, type TelemetryEvent } from "../orchestrator/telemetry.ts";
import { writeFileEnsured } from "../orchestrator/util.ts";
import { Jira } from "../orchestrator/jira.ts";

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

export interface UsageRow {
  ticket: string; story_points?: number; estimate_hours?: number; runs: number; agent_minutes: number;
  cost_usd: number; tokens_in: number; tokens_out: number; tokens_cache_read?: number;
  /** Percent of the 5-hour / 7-day plan window this ticket's runs used. */
  five_hour_pct?: number; seven_day_pct?: number;
  /** measured: every run reported the plan window; estimated: none did (percent per dollar from measured runs);
   *  mixed: some of each; none: nothing to go on. */
  window_source: "measured" | "estimated" | "mixed" | "none";
}

/** What one run used of a window: end - start; across a reset, only what it used in the new window. */
const used = (w?: { start: number; end: number }) => (w ? (w.end >= w.start ? w.end - w.start : w.end) : undefined);
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Plan usage per ticket and per story point. A ticket's share of a window is the sum of what each of its runs moved
 * the window (start to end of that run), so other sessions between runs are not counted; work in other sessions
 * during a run is (the window belongs to the developer, not the workflow). Runs without a plan window (before it
 * was recorded) are estimated from the measured percent per dollar. `points` adds story points from Jira.
 */
export function planUsage(events: TelemetryEvent[], points: Record<string, number> = {}, hours: Record<string, number> = {}) {
  const runs = events.filter((e) => e.event === "run" && e.ticket);
  const measured = runs.filter((e) => e.plan_window?.five_hour);
  const measuredCost = measured.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
  const per = (k: "five_hour" | "seven_day") => {
    const m = measured.filter((e) => e.plan_window?.[k]);
    const cost = m.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
    return cost > 0 ? m.reduce((s, e) => s + used(e.plan_window![k])!, 0) / cost : undefined;
  };
  const pctPerUsd = { five_hour: per("five_hour"), seven_day: per("seven_day") };
  const rows = new Map<string, UsageRow & { _m: number; _u: number; f: number; w: number }>();
  for (const e of runs) {
    const r = rows.get(e.ticket!) ?? { ticket: e.ticket!, runs: 0, agent_minutes: 0, cost_usd: 0, tokens_in: 0, tokens_out: 0, window_source: "none" as const, _m: 0, _u: 0, f: 0, w: 0 };
    r.runs++;
    r.cost_usd += e.cost_usd ?? 0;
    r.tokens_in += e.tokens_in ?? 0;
    r.tokens_out += e.tokens_out ?? 0;
    if (e.tokens_cache_read !== undefined) r.tokens_cache_read = (r.tokens_cache_read ?? 0) + e.tokens_cache_read;
    if (e.started_at && e.ended_at) r.agent_minutes += (Date.parse(e.ended_at) - Date.parse(e.started_at)) / 60e3;
    const d = e.detail as { story_points?: number; estimate_hours?: number } | undefined;
    if (typeof d?.story_points === "number") r.story_points = d.story_points;
    if (typeof d?.estimate_hours === "number") r.estimate_hours = d.estimate_hours;
    if (e.plan_window?.five_hour) { r._m++; r.f += used(e.plan_window.five_hour)!; r.w += used(e.plan_window.seven_day) ?? (pctPerUsd.seven_day ?? 0) * (e.cost_usd ?? 0); }
    else if ((e.cost_usd ?? 0) > 0) { r._u++; if (pctPerUsd.five_hour !== undefined) { r.f += pctPerUsd.five_hour * e.cost_usd!; r.w += (pctPerUsd.seven_day ?? 0) * e.cost_usd!; } }
    rows.set(e.ticket!, r);
  }
  const tickets: UsageRow[] = [...rows.values()].map(({ _m, _u, f, w, ...r }) => {
    if (points[r.ticket] !== undefined) r.story_points = points[r.ticket];
    if (hours[r.ticket] !== undefined) r.estimate_hours = hours[r.ticket];
    const source: UsageRow["window_source"] = _m && _u ? "mixed" : _m ? "measured" : _u && pctPerUsd.five_hour !== undefined ? "estimated" : "none";
    const known = source !== "none";
    return { ...r, agent_minutes: Math.round(r.agent_minutes), window_source: source, ...(known ? { five_hour_pct: round1(f), ...(pctPerUsd.seven_day !== undefined || _m ? { seven_day_pct: round1(w) } : {}) } : {}) };
  }).sort((a, b) => a.ticket.localeCompare(b.ticket, undefined, { numeric: true }));
  const sized = tickets.filter((t) => t.story_points);
  const pts = sized.reduce((s, t) => s + t.story_points!, 0);
  const withWindow = sized.filter((t) => t.five_hour_pct !== undefined);
  const wpts = withWindow.reduce((s, t) => s + t.story_points!, 0);
  const fivePerPoint = wpts ? withWindow.reduce((s, t) => s + t.five_hour_pct!, 0) / wpts : undefined;
  const weekPerPoint = wpts && withWindow.every((t) => t.seven_day_pct !== undefined) ? withWindow.reduce((s, t) => s + t.seven_day_pct!, 0) / wpts : undefined;
  return {
    tickets,
    measured_runs: measured.length,
    pct_per_usd: pctPerUsd,
    measured_cost_usd: measuredCost,
    per_point: {
      points: pts,
      cost_usd: pts ? sized.reduce((s, t) => s + t.cost_usd, 0) / pts : undefined,
      tokens: pts ? sized.reduce((s, t) => s + t.tokens_in + t.tokens_out, 0) / pts : undefined,
      agent_minutes: pts ? sized.reduce((s, t) => s + t.agent_minutes, 0) / pts : undefined,
      five_hour_pct: fivePerPoint,
      seven_day_pct: weekPerPoint,
      points_per_window: fivePerPoint ? 100 / fivePerPoint : undefined,
      points_per_week: weekPerPoint ? 100 / weekPerPoint : undefined,
    },
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

const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const pct = (n?: number) => (n === undefined ? "-" : `${n.toFixed(1)}%`);

/** The plan usage section as text: per ticket, then per story point and the projection. */
export function usageTable(u: ReturnType<typeof planUsage>): string {
  const head = "ticket        SP  est(h)  agent(min)  cost($)  tokens in/out     5h-window  7-day   source";
  const rows = u.tickets.map((t) => `${t.ticket.padEnd(13)} ${String(t.story_points ?? "-").padStart(2)} ${String(t.estimate_hours ?? "-").padStart(7)} ${String(t.agent_minutes).padStart(11)} ${t.cost_usd.toFixed(2).padStart(8)}  ${`${big(t.tokens_in)}/${big(t.tokens_out)}`.padEnd(16)} ${pct(t.five_hour_pct).padStart(9)} ${pct(t.seven_day_pct).padStart(6)}   ${t.window_source}`);
  const p = u.per_point;
  return [
    "Plan usage: how much of your Claude plan's limits the workflow used, per ticket and per story point",
    head, ...rows, "",
    p.points ? `Per story point (${p.points} points): $${p.cost_usd!.toFixed(2)} · ${big(p.tokens!)} tokens · ${Math.round(p.agent_minutes!)} agent-minutes · ${pct(p.five_hour_pct)} of a 5-hour window · ${pct(p.seven_day_pct)} of the week`
      : "No story points yet: they come from Jira at extract (or run the report with --jira).",
    p.points_per_window ? `Projection: about ${p.points_per_window.toFixed(1)} story points per 5-hour window${p.points_per_week ? `, ${p.points_per_week.toFixed(0)} per week` : ""}, if a developer's plan is used only by the workflow.` : "",
    u.measured_runs ? `Measured from ${u.measured_runs} run(s) that reported the plan window; others estimated at ${u.pct_per_usd.five_hour!.toFixed(2)}% of the 5-hour window per dollar.`
      : "No run has reported the plan window yet (recorded from now on; API-key accounts have none). Window figures appear after the next run.",
  ].filter(Boolean).join("\n");
}

/** The plan usage section as HTML: headline tiles, the 5-hour window per ticket (bars), and the table. */
export function usageHtml(u: ReturnType<typeof planUsage>): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const p = u.per_point;
  const tile = (label: string, value: string, note = "") => `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div>${note ? `<div class="tn">${esc(note)}</div>` : ""}</div>`;
  const tiles = `<div class="tiles">${[
    tile("Story points per 5-hour window", p.points_per_window ? `≈ ${p.points_per_window.toFixed(1)}` : "-", p.points_per_window ? "if the plan is used only by the workflow" : "after the first measured run"),
    tile("5-hour window per story point", pct(p.five_hour_pct)),
    tile("Week (7-day) per story point", pct(p.seven_day_pct)),
    tile("Cost per story point", p.cost_usd !== undefined ? `$${p.cost_usd.toFixed(2)}` : "-"),
    tile("Tokens per story point", p.tokens !== undefined ? big(p.tokens) : "-"),
  ].join("")}</div>`;
  const bars = u.tickets.filter((t) => t.five_hour_pct !== undefined);
  const scale = Math.max(10, Math.ceil((Math.max(0, ...bars.map((t) => t.five_hour_pct!)) * 1.1) / 10) * 10);
  const W = 640, L = 84, R = 170, rowH = 34, barH = 18, H = bars.length * rowH + 28;
  const x = (v: number) => L + (v / scale) * (W - L - R);
  const grid = [0, scale / 2, scale].map((v) => `<line x1="${x(v)}" x2="${x(v)}" y1="0" y2="${H - 22}" class="grid"/><text x="${x(v)}" y="${H - 6}" class="axis" text-anchor="middle">${v}%</text>`).join("");
  const marks = bars.map((t, i) => {
    const y = i * rowH + (rowH - barH) / 2, w = Math.max(6, x(t.five_hour_pct!) - L);
    const tip = `${t.ticket}: ${pct(t.five_hour_pct)} of the 5-hour window, ${pct(t.seven_day_pct)} of the week, $${t.cost_usd.toFixed(2)}${t.story_points ? `, ${t.story_points} SP` : ""} (${t.window_source})`;
    return `<g class="bar"><title>${esc(tip)}</title><rect x="0" y="${i * rowH}" width="${W}" height="${rowH}" fill="transparent"/>`
      + `<text x="${L - 10}" y="${y + barH / 2 + 4}" class="lbl" text-anchor="end">${esc(t.ticket)}</text>`
      + `<path d="M${L},${y} h${w - 4} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h-${w - 4} z" class="${t.window_source === "measured" ? "m" : "e"}"/>`
      + `<text x="${L + w + 8}" y="${y + barH / 2 + 4}" class="val">${pct(t.five_hour_pct)}${t.story_points ? ` · ${t.story_points} SP` : ""}${t.window_source === "measured" ? "" : ` · ${t.window_source}`}</text></g>`;
  }).join("");
  const chart = bars.length ? `<h3>Share of a 5-hour window, per ticket</h3><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Percent of the 5-hour plan window used per ticket">${grid}${marks}</svg>
<p class="muted">Solid: measured from the plan window the runs reported. Hatched: estimated from cost${u.pct_per_usd.five_hour !== undefined ? ` at ${u.pct_per_usd.five_hour.toFixed(2)}% per dollar` : ""}.</p>` : `<p class="muted">No run has reported the plan window yet; it is recorded from now on (subscriptions only).</p>`;
  const rows = u.tickets.map((t) => `<tr><td>${esc(t.ticket)}</td><td>${t.story_points ?? "-"}</td><td>${t.estimate_hours ?? "-"}</td><td>${t.agent_minutes}</td><td>$${t.cost_usd.toFixed(2)}</td><td>${big(t.tokens_in)} / ${big(t.tokens_out)}</td><td>${pct(t.five_hour_pct)}</td><td>${pct(t.seven_day_pct)}</td><td>${t.window_source}</td></tr>`).join("");
  return `<h2>Plan usage per story point</h2><p class="muted">How much of a developer's Claude plan limits (the rolling 5-hour window and the week) the workflow used, per ticket and per story point.</p>${tiles}${chart}
<div class="wrap"><table><tr><th>Ticket</th><th>SP</th><th>Est. (h)</th><th>Agent min</th><th>Cost</th><th>Tokens in / out</th><th>5-hour window</th><th>Week</th><th>Source</th></tr>${rows}</table></div>`;
}

export function html(r: ReturnType<typeof aggregate>, since: string, usage?: ReturnType<typeof planUsage>): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const rows = r.tickets.map((t) => `<tr><td>${esc(t.ticket)}</td><td>${t.runs}</td><td>${t.passes}</td><td>${t.fails}</td><td>${t.escalations}</td><td>$${t.cost_usd.toFixed(2)}</td><td>${t.cycle_hours.toFixed(1)} h</td></tr>`).join("");
  const arows = r.agents.map((a) => `<tr><td>${esc(a.agent)}</td><td>${a.runs}</td><td>$${a.cost_usd.toFixed(2)}</td><td>${(a.fail_rate * 100).toFixed(0)}%</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent runs</title>
<style>:root{--bg:#fcfcfb;--fg:#0b0b0b;--muted:#52514e;--line:#e5e4e0;--tile:#f3f2ef;--s1:#2a78d6}@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#f0efec;--muted:#c3c2b7;--line:#33322f;--tile:#242422;--s1:#3987e5}}
.muted{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0}.tile{background:var(--tile);border-radius:8px;padding:12px 14px}.tl{color:var(--muted);font-size:12px}.tv{font-size:24px;font-weight:600;margin-top:4px}.tn{color:var(--muted);font-size:11px;margin-top:2px}
svg .grid{stroke:var(--line);stroke-width:1}svg .axis,svg .val{fill:var(--muted);font-size:12px}svg .lbl{fill:var(--fg);font-size:12px}svg .m{fill:var(--s1)}svg .e{fill:url(#hatch)}svg .bar:hover .val{fill:var(--fg)}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:24px 16px}
table{border-collapse:collapse;width:100%;margin:12px 0 32px}th,td{text-align:right;padding:6px 10px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}th{color:var(--muted);font-weight:500}
.wrap{overflow-x:auto}</style></head><body>
<h1>Agent runs since ${esc(since)}</h1><p style="color:var(--muted)">${r.events} events · generated ${new Date().toISOString()}</p>
<h2>Per ticket: cost and cycle time</h2><div class="wrap"><table><tr><th>Ticket</th><th>Runs</th><th>Pass</th><th>Fail</th><th>Escalated</th><th>Cost</th><th>Cycle</th></tr>${rows}</table></div>
<h2>Per agent</h2><div class="wrap"><table><tr><th>Agent</th><th>Runs</th><th>Cost</th><th>Fail rate</th></tr>${arows}</table></div>
${usage ? usageHtml(usage) : ""}<svg width="0" height="0" style="position:absolute"><defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--s1)" opacity="0.35"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--s1)" stroke-width="3"/></pattern></defs></svg></body></html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const root = repoRoot();
  const since = flag("since") ?? "7d";
  const events = readEvents(telemetryFile(root, loadConfig(root).telemetry.file));
  const r = aggregate(events, parseSince(since));
  const recent = events.filter((e) => Date.parse(e.ended_at ?? e.started_at ?? "") >= parseSince(since));
  // --jira: story points for tickets run before extract recorded them.
  const points: Record<string, number> = {};
  const hours: Record<string, number> = {};
  const jira = argv.includes("--jira") ? Jira.fromEnv() : undefined;
  if (argv.includes("--jira") && !jira) console.error("--jira needs JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN; showing story points recorded at extract only.");
  const keys = [...new Set(recent.filter((e) => e.event === "run" && e.ticket && /^[A-Z][A-Z0-9]+-\d+$/.test(e.ticket)).map((e) => e.ticket!))];
  if (jira && keys.length) {
    try { for (const i of await jira.search(`key in (${keys.join(",")})`, 100)) { if (i.storyPoints !== undefined) points[i.key] = i.storyPoints; if (i.estimateHours !== undefined) hours[i.key] = i.estimateHours; } }
    catch (e) { console.error(`Jira story points: ${String(e).slice(0, 200)}`); }
  }
  const usage = planUsage(recent, points, hours);
  const out = flag("html");
  if (out) { writeFileEnsured(out, html(r, since, usage)); console.log(`dashboard written: ${out}`); }
  else console.log(`${table(r)}\n\n${usageTable(usage)}`);
}
