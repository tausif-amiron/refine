// Agent runners. The default runs Claude Code headless:
//   claude -p --agent <name> --output-format stream-json --verbose --model <m> --permission-mode dontAsk --max-budget-usd <n>
// with the brief on stdin, in the unit's worktree. Permissions come from .claude/settings.json
// (dontAsk denies anything not pre-approved) and the agent's own `tools` list; hooks enforce SCOPE.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import type { AgentRunResult, ModelUsage, PlanWindow } from "./types.ts";
import { run } from "./util.ts";

export interface AgentRunRequest {
  agent: string;
  prompt: string;
  cwd: string;
  model: string;
  budgetUsd: number;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Extra CLI args (e.g. --strict-mcp-config for the score agent). */
  extraArgs?: string[];
}

export interface AgentRunner {
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}

export function cliArgs(req: AgentRunRequest): string[] {
  return [
    "-p",
    "--agent", req.agent,
    // stream-json (with --verbose, which it requires) also carries rate_limit_event messages: the plan's 5-hour and
    // 7-day windows, so each run can say how much of a developer's plan it used.
    "--output-format", "stream-json", "--verbose",
    "--model", req.model,
    "--permission-mode", "dontAsk",
    "--max-budget-usd", String(req.budgetUsd),
    ...(req.extraArgs ?? []),
  ];
}

/**
 * The plan windows from rate_limit_event messages: the first sample is the start of the run, the last its end.
 * Utilization arrives as a 0-1 fraction; stored as percent. Only subscriptions send these (not API keys).
 */
export function planWindowOf(messages: any[]): PlanWindow | undefined {
  const out: PlanWindow = {};
  for (const m of messages) {
    if (m?.type !== "rate_limit_event") continue;
    const info = m.rate_limit_info ?? {};
    const windows: Record<string, { utilization?: number; resetsAt?: number }> = info.unifiedWindows
      ?? (info.rateLimitType && typeof info.utilization === "number" ? { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } } : {});
    for (const key of ["five_hour", "seven_day"] as const) {
      const w = windows[key];
      if (typeof w?.utilization !== "number") continue;
      const pct = Math.round(w.utilization * 1000) / 10;
      const resets_at = typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : undefined;
      out[key] = { start: out[key]?.start ?? pct, end: pct, ...(resets_at ? { resets_at } : {}) };
    }
  }
  return out.five_hour || out.seven_day ? out : undefined;
}

/** Parse `claude -p` output: stream-json lines, or json (an object, or an array of messages ending in a result). */
export function parseCliOutput(stdout: string): AgentRunResult {
  let messages: any[];
  try { const p = JSON.parse(stdout); messages = Array.isArray(p) ? p : [p]; } catch {
    messages = stdout.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    if (!messages.length) return { ok: false, text: stdout.slice(-4000), cost_usd: 0, tokens_in: 0, tokens_out: 0, cost_source: "unknown" };
  }
  const result = [...messages].reverse().find((m) => m?.type === "result" || (messages.length === 1 && m && typeof m === "object")) as Record<string, any> | undefined;
  if (!result) return { ok: false, text: "no result message in CLI output", cost_usd: 0, tokens_in: 0, tokens_out: 0, cost_source: "unknown", raw: messages };
  const u = result.usage ?? {};
  const models: Record<string, ModelUsage> = {};
  for (const [name, m] of Object.entries((result.modelUsage ?? {}) as Record<string, any>)) {
    models[name] = { in: Number(m.inputTokens ?? 0), out: Number(m.outputTokens ?? 0), cache_read: Number(m.cacheReadInputTokens ?? 0), cache_write: Number(m.cacheCreationInputTokens ?? 0), cost_usd: Number(m.costUSD ?? 0) };
  }
  const plan_window = planWindowOf(messages);
  return {
    ok: !result.is_error && (result.subtype === undefined || result.subtype === "success"),
    text: String(result.result ?? result.error ?? result.subtype ?? ""),
    cost_usd: Number(result.total_cost_usd ?? 0),
    tokens_in: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
    tokens_out: Number(u.output_tokens ?? 0),
    tokens_cache_read: Number(u.cache_read_input_tokens ?? 0),
    tokens_cache_write: Number(u.cache_creation_input_tokens ?? 0),
    ...(Object.keys(models).length ? { models } : {}),
    ...(plan_window ? { plan_window } : {}),
    cost_source: "cli",
    session_id: result.session_id,
    raw: result,
  };
}

export class UntrustedWorkspaceError extends Error {
  constructor(cwd: string, stderr: string) {
    const line = stderr.split("\n").find((l) => /has not been trusted/i.test(l))?.trim() ?? "";
    super(`Claude Code has not trusted this repository, so it ignored the permissions in .claude/settings.json and the agent could not edit anything. No attempt was counted.\n${line}\nOpen the repository once in interactive Claude Code (run \`claude\` in its root), accept the trust dialog, then run the build again. (Agent ran in ${cwd}.)`);
    this.name = "UntrustedWorkspaceError";
  }
}

export class CliRunner implements AgentRunner {
  constructor(private bin = process.env.CLAUDE_BIN ?? "claude") {}
  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const r = await run(this.bin, cliArgs(req), {
      cwd: req.cwd,
      env: { ...process.env, ...req.env, CLAUDE_PROJECT_DIR: req.cwd },
      input: req.prompt,
      timeoutMs: req.timeoutMs ?? 60 * 60_000,
    });
    // An untrusted workspace makes Claude Code ignore .claude/settings.json's allow list, so dontAsk denies every
    // edit and the attempt looks like "no change". That is the machine, not the unit: stop the build and say why.
    if (/has not been trusted/i.test(r.stderr)) throw new UntrustedWorkspaceError(req.cwd, r.stderr);
    const out = parseCliOutput(r.stdout);
    if (r.code !== 0 && out.ok) out.ok = false;
    if (!out.ok && r.stderr) out.text = `${out.text}\n${r.stderr.slice(-2000)}`.trim();
    return out;
  }
}

/** Read an agent definition (.claude/agents/<name>.md): frontmatter + body. */
export function readAgentDefinition(root: string, name: string): { tools: string[]; model?: string; body: string } {
  const text = readFileSync(join(root, ".claude", "agents", `${name}.md`), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { tools: [], body: text };
  const fm = (yamlParse(m[1]) ?? {}) as Record<string, unknown>;
  const tools = typeof fm.tools === "string" ? fm.tools.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(fm.tools) ? (fm.tools as string[]) : [];
  return { tools, model: fm.model as string | undefined, body: m[2] };
}

/** Agent SDK runner (AI_SDLC_RUNNER=sdk). Same agent files, same project settings and hooks. */
export class SdkRunner implements AgentRunner {
  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const sdk: any = await import("@anthropic-ai/claude-agent-sdk");
    const def = readAgentDefinition(req.cwd, req.agent);
    let last: any;
    const limits: any[] = [];
    const stream = sdk.query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        model: req.model,
        permissionMode: "dontAsk",
        settingSources: ["project"],
        allowedTools: def.tools,
        systemPrompt: { type: "preset", preset: "claude_code", append: def.body },
        maxBudgetUsd: req.budgetUsd,
        env: { ...process.env, ...req.env, CLAUDE_PROJECT_DIR: req.cwd },
      },
    });
    for await (const msg of stream) { if (msg?.type === "result") last = msg; if (msg?.type === "rate_limit_event") limits.push(msg); }
    if (!last) return { ok: false, text: "no result from SDK", cost_usd: 0, tokens_in: 0, tokens_out: 0, cost_source: "sdk" };
    const out = parseCliOutput([...limits, last].map((m) => JSON.stringify(m)).join("\n"));
    return { ...out, cost_source: "sdk" };
  }
}

export function defaultRunner(): AgentRunner {
  return process.env.AI_SDLC_RUNNER === "sdk" ? new SdkRunner() : new CliRunner();
}
