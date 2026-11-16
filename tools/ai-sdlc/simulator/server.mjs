#!/usr/bin/env node
// Data-source simulator: a legacy system with no API (an HTML page and a nightly CSV export), plus the
// operational surface the ops loop needs: /healthz, /metrics, structured logs, and a fault switch.
//
//   GET  /legacy/invoices.html   HTML table (scrape target)
//   GET  /legacy/export.csv      nightly export (CSV), stable source ids
//   GET  /healthz                200 ok, or 503 under fault "down"
//   GET  /metrics                Prometheus text: requests, errors, error rate
//   POST /__fault                {"mode": "none" | "error" | "latency" | "down" | "malformed", "rate": 0..1}
//   POST /__reset                clear counters and faults
//
// Rate limit: 60 requests/minute per client → 429 with Retry-After (wrappers must back off).
import { createServer } from "node:http";

const PORT = Number(process.env.SIMULATOR_PORT ?? 4010);
const LIMIT = Number(process.env.SIMULATOR_RATE_LIMIT ?? 60);

const vendors = [
  { id: "V-001", name: "Acme Supplies" },
  { id: "V-002", name: "Globex Logistics" },
  { id: "V-003", name: "Initech Services" },
];

export function invoices(count = 25) {
  return Array.from({ length: count }, (_, i) => {
    const v = vendors[i % vendors.length];
    const day = String((i % 27) + 1).padStart(2, "0");
    return { source_id: `ERP-${10000 + i}`, vendor_id: v.id, vendor_name: v.name, number: `INV-${2026}${String(i + 1).padStart(4, "0")}`, amount: (125.5 + i * 37.25).toFixed(2), due_date: `2026-12-${day}`, status: "pending" };
  });
}

const state = { fault: { mode: "none", rate: 1 }, requests: 0, errors: 0, buckets: new Map() };

function log(level, msg, fields = {}) {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), level, service: "legacy-erp-simulator", msg, ...fields }) + "\n");
}

function rateLimited(req) {
  const key = req.socket.remoteAddress ?? "local";
  const minute = Math.floor(Date.now() / 60_000);
  const b = state.buckets.get(key);
  if (!b || b.minute !== minute) { state.buckets.set(key, { minute, n: 1 }); return false; }
  b.n++;
  return b.n > LIMIT;
}

function csv(rows) {
  const cols = ["source_id", "vendor_id", "vendor_name", "number", "amount", "due_date", "status"];
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

function html(rows) {
  return `<!doctype html><html><head><title>ERP Invoices</title></head><body><h1>Open invoices</h1><table id="invoices"><tr><th>Ref</th><th>Vendor</th><th>No.</th><th>Amount</th><th>Due</th></tr>${rows.map((r) => `<tr data-ref="${r.source_id}"><td>${r.source_id}</td><td>${r.vendor_name}</td><td>${r.number}</td><td>${r.amount}</td><td>${r.due_date}</td></tr>`).join("")}</table></body></html>`;
}

async function body(req) {
  let s = "";
  for await (const c of req) s += c;
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

export function createSimulator() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code, type, text, headers = {}) => { res.writeHead(code, { "content-type": type, ...headers }); res.end(text); };

    if (url.pathname === "/__fault" && req.method === "POST") {
      const b = await body(req);
      state.fault = { mode: b.mode ?? "none", rate: typeof b.rate === "number" ? b.rate : 1 };
      log("warn", "fault set", state.fault);
      return send(200, "application/json", JSON.stringify(state.fault));
    }
    if (url.pathname === "/__reset" && req.method === "POST") {
      Object.assign(state, { fault: { mode: "none", rate: 1 }, requests: 0, errors: 0, buckets: new Map() });
      return send(200, "application/json", "{}");
    }
    if (url.pathname === "/metrics") {
      const rate = state.requests ? state.errors / state.requests : 0;
      return send(200, "text/plain", `sim_requests_total ${state.requests}\nsim_errors_total ${state.errors}\nsim_error_rate ${rate.toFixed(4)}\n`);
    }
    if (url.pathname === "/healthz") return state.fault.mode === "down" ? send(503, "text/plain", "down") : send(200, "text/plain", "ok");

    state.requests++;
    if (rateLimited(req)) { log("warn", "rate limited", { path: url.pathname }); return send(429, "text/plain", "slow down", { "retry-after": "30" }); }
    const hit = Math.random() < state.fault.rate;
    if (hit && (state.fault.mode === "error" || state.fault.mode === "down")) {
      state.errors++;
      log("error", "ExportGenerationError: could not render export for batch 4711", { path: url.pathname, request_id: Math.random().toString(16).slice(2, 10) });
      return send(500, "text/plain", "internal error");
    }
    if (hit && state.fault.mode === "latency") await new Promise((r) => setTimeout(r, 5000));

    const rows = invoices(Number(url.searchParams.get("count") ?? 25));
    if (url.pathname === "/legacy/export.csv") {
      let text = csv(rows);
      if (hit && state.fault.mode === "malformed") text = text.replace(/\n(ERP-10003[^\n]*)/, "\n$1,UNEXPECTED,COLUMNS");
      log("info", "export served", { rows: rows.length });
      return send(200, "text/csv", text);
    }
    if (url.pathname === "/legacy/invoices.html") return send(200, "text/html", html(rows));
    return send(404, "text/plain", "not found");
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createSimulator().listen(PORT, () => log("info", `simulator listening on http://localhost:${PORT}`));
}
