// Paperclip as the live dashboard for the workflow. When `paperclip.url` is set, every command reports its stage on the
// ticket's Paperclip issue (one per ticket, in the repo's Paperclip project): what started, what passed or failed,
// progress lines from the build and QA as they happen, and when the ticket is waiting for a person (then the issue is
// blocked on the board). It only reports: Jira stays the source of truth and code still decides pass or fail.
// Reporting never breaks a run; a failure is one warning.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { writeFileEnsured } from "./util.ts";

export interface DashboardApi {
  /** The board user's id (Paperclip will not put an unassigned issue in progress). */
  whoAmI(): Promise<string | undefined>;
  listIssues(companyId: string): Promise<{ id: string; title: string }[]>;
  createIssue(o: { companyId: string; projectId?: string; title: string; description: string; assigneeUserId?: string }): Promise<{ id: string }>;
  comment(id: string, body: string): Promise<void>;
  update(id: string, patch: Record<string, unknown>): Promise<void>;
}

export type Stage = "extract" | "plan" | "build" | "gates" | "qa" | "pr";
export type StageState = "started" | "progress" | "passed" | "failed" | "waiting";
const STAGE_NAME: Record<Stage, string> = { extract: "Extract", plan: "Plan", build: "Build", gates: "Gates", qa: "QA", pr: "PR" };
const STATE_WORD: Record<Exclude<StageState, "progress">, string> = { started: "started", passed: "passed", failed: "failed", waiting: "waiting for you" };

export class HttpDashboardApi implements DashboardApi {
  constructor(private base: string, private key?: string, private fetchImpl: typeof fetch = fetch) {}
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, "")}/api${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Paperclip ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  async whoAmI() { const r = await this.call<{ user?: { id?: string } }>("GET", "/auth/get-session").catch(() => undefined); return r?.user?.id; }
  async listIssues(companyId: string) { const r = await this.call<{ id: string; title: string }[] | { issues: { id: string; title: string }[] }>("GET", `/companies/${companyId}/issues`); return Array.isArray(r) ? r : r.issues ?? []; }
  createIssue(o: { companyId: string; projectId?: string; title: string; description: string; assigneeUserId?: string }) {
    return this.call<{ id: string }>("POST", `/companies/${o.companyId}/issues`, { title: o.title, description: o.description, status: "todo", ...(o.projectId ? { projectId: o.projectId } : {}), ...(o.assigneeUserId ? { assigneeUserId: o.assigneeUserId } : {}) });
  }
  async comment(id: string, body: string) { await this.call("POST", `/issues/${id}/comments`, { body }); }
  async update(id: string, patch: Record<string, unknown>) { await this.call("PATCH", `/issues/${id}`, patch); }
}

export function dashboardFor(root: string, cfg: Config, api?: DashboardApi, warn: (m: string) => void = (m) => process.stderr.write(`${m}\n`)) {
  const pc = cfg.paperclip;
  const on = Boolean(pc?.url && pc.companyId && pc.report !== false);
  const client = api ?? (on ? new HttpDashboardApi(pc!.url, process.env.PAPERCLIP_BOARD_KEY) : undefined);
  const ids = new Map<string, string>();
  let owner: Promise<string | undefined> | undefined;
  const ownerId = () => (owner ??= client!.whoAmI().catch(() => undefined));
  let warned = false;
  let chain: Promise<void> = Promise.resolve();
  const record = (t: string) => join(root, ".ai-sdlc", "tickets", `${t}.paperclip.json`);

  const issueId = async (ticket: string): Promise<string> => {
    const known = ids.get(ticket) ?? (existsSync(record(ticket)) ? (JSON.parse(readFileSync(record(ticket), "utf8")) as { issueId: string }).issueId : undefined);
    if (known) { ids.set(ticket, known); return known; }
    const existing = (await client!.listIssues(pc!.companyId)).find((i) => new RegExp(`^${ticket}(\\b|:)`).test(i.title));
    const jira = process.env.JIRA_BASE_URL ? `Jira: ${process.env.JIRA_BASE_URL.replace(/\/$/, "")}/browse/${ticket}\n\n` : "";
    const id = existing?.id ?? (await client!.createIssue({ companyId: pc!.companyId, projectId: pc!.projectId, title: ticket, assigneeUserId: await ownerId(), description: `${jira}Runs through the AI-SDLC workflow. Each stage is posted here as it happens; the PR carries the full evidence.` })).id;
    ids.set(ticket, id);
    writeFileEnsured(record(ticket), JSON.stringify({ issueId: id }, null, 2) + "\n");
    return id;
  };

  const safely = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) {
      if (!warned) { warned = true; warn(`Paperclip dashboard: could not report (${(e as Error).message}). The workflow continues; check that Paperclip runs at ${pc?.url}.`); }
    }
  };

  const stage = async (ticket: string, s: Stage, state: StageState, text: string) => {
    if (!on) return;
    await safely(async () => {
      const id = await issueId(ticket);
      await client!.comment(id, state === "progress" ? `**${STAGE_NAME[s]}**: ${text}` : `**${STAGE_NAME[s]}** ${STATE_WORD[state]}: ${text}`);
      // Inside a Paperclip run the runner agent owns the issue and its status (paperclip-run): only comment, or a
      // status or owner change would take the issue from the agent.
      if (state === "progress" || process.env.PAPERCLIP_RUN_ID) return;
      // A person-step blocks the issue on the board, saying what they do; a PR waits for review; otherwise it is moving.
      const patch = state === "waiting" || state === "failed"
        ? { status: "blocked", unblockDescriptor: { owner: "board", action: state === "failed" ? `Look at the failure: ${text}` : text } }
        : { status: s === "pr" && state === "passed" ? "in_review" : "in_progress" };
      const who = await ownerId();
      await client!.update(id, who ? { ...patch, assigneeUserId: who } : patch);
    });
  };

  return {
    stage,
    /** Name the issue after the ticket once its title is known (the IR's). */
    title: async (ticket: string, title: string) => {
      if (!on) return;
      await safely(async () => { await client!.update(await issueId(ticket), { title: `${ticket}: ${title}` }); });
    },
    /** Progress lines from a running stage, posted in order without blocking the caller. */
    progress: (ticket: string, s: Stage, line: string) => { chain = chain.then(() => stage(ticket, s, "progress", line)); },
    flush: () => chain,
  };
}
