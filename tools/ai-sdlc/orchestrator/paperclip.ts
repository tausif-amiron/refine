// Paperclip as the outer control plane. A Paperclip "process" agent runs `ai-sdlc paperclip-run` for its repository;
// each run moves the ticket of the issue that woke it forward, one ai-sdlc step at a time, until a person is needed.
// What a person does (answer IR questions, take over an escalated unit, look at a failure, open the PR) becomes a
// board approval, and the issue is blocked on it; approving it wakes the agent again. Code decides pass or fail, as
// everywhere else: Paperclip only starts the steps and shows them. Jira stays the source of truth; `paperclip-sync`
// mirrors ready Jira tickets into Paperclip issues. Findings from the trial that shaped this:
// - a run may only write to the issue it was woken for, so it acts on that one issue;
// - releasing an issue un-assigns it, so progress is shown with statuses instead;
// - agents may not name the board as an unblock owner, so waiting on a person is an approval request;
// - GitHub is isolated inside runs (own gh config, no SSH agent): `pr` needs GH_TOKEN in the agent's environment;
// - Paperclip's per-run TMPDIR is too deep for tsx's socket, so steps run with TMPDIR=/tmp.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { WORKFLOW_ROOT } from "./config.ts";

export type Step = "extract" | "plan" | "run" | "pr";
export interface Approval { id: string; status: string; decidedAt?: string; decisionNote?: string; payload: { action: string; ticket: string; title: string } }
export interface PaperclipApi {
  getRun(id: string): Promise<{ contextSnapshot?: { issueId?: string; wakeReason?: string } }>;
  getIssue(id: string): Promise<{ id: string; identifier?: string; title: string; status: string }>;
  checkout(issueId: string, agentId: string): Promise<void>;
  comment(issueId: string, body: string): Promise<void>;
  setStatus(issueId: string, status: string): Promise<void>;
  approvals(issueId: string): Promise<Approval[]>;
  requestApproval(issueId: string, payload: Approval["payload"], companyId: string, agentId: string): Promise<void>;
  listIssues(companyId: string): Promise<{ id: string; title: string }[]>;
  createIssue(o: { companyId: string; title: string; description: string; assigneeAgentId: string }): Promise<{ id: string; identifier?: string }>;
}
export type StepRunner = (step: Step, ticket: string) => Promise<{ code: number; output: string }>;

/** What a person must do: "answers" (IR questions), "escalation" (finish a unit), "failure" (look at a failed step),
 *  "pr" (agree to open it), "merge" (review and merge it on GitHub). */
export type PersonAction = "answers" | "escalation" | "failure" | "pr" | "merge";
export type Next =
  | { kind: "step"; step: Exclude<Step, "pr"> }
  | { kind: "person"; action: PersonAction; text: string }
  | { kind: "review"; url: string };

const readJson = <T>(p: string): T | undefined => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined);

/** The ticket's next action, from the files the ai-sdlc steps write (no git or network). */
export function nextAction(root: string, ticket: string): Next {
  const ir = readJson<{ questions: { answer?: string }[]; unplaced?: unknown[] }>(join(root, "ir", `${ticket}.ir.json`));
  if (!ir) return { kind: "step", step: "extract" };
  const open = ir.questions.filter((q) => !q.answer).length + (ir.unplaced?.length ?? 0);
  if (open) return { kind: "person", action: "answers", text: `Answer the ${open} open question(s) in ir/${ticket}.ir.json (questions[].answer), commit, then approve to plan and build.` };
  if (!existsSync(join(root, "ir", `${ticket}.plan.json`))) return { kind: "step", step: "plan" };
  const state = readJson<{ units: Record<string, { status: string }> }>(join(root, ".ai-sdlc", "state", `${ticket}.json`));
  if (!state) return { kind: "step", step: "run" };
  const units = Object.entries(state.units);
  const escalated = units.filter(([, u]) => u.status === "escalated").map(([id]) => id);
  if (escalated.length) return { kind: "person", action: "escalation", text: `A developer finishes ${escalated.join(", ")} (see .ai-sdlc/reports/${ticket}/), then approve to continue.` };
  if (!units.every(([, u]) => u.status === "passed")) return { kind: "step", step: "run" };
  const pr = readJson<{ url: string }>(join(root, ".ai-sdlc", "reports", ticket, "pr.json"));
  if (pr) return { kind: "review", url: pr.url };
  return { kind: "person", action: "pr", text: `Every unit and QA passed. Approve to push the branch and open the pull request (a person still approves the PR itself).` };
}

const tail = (s: string, lines = 60) => s.trimEnd().split("\n").slice(-lines).join("\n");
const stepComment = (step: Step, ticket: string, r: { code: number; output: string }) =>
  [`**ai-sdlc ${step} ${ticket}**: exit ${r.code}`, "", "```", tail(r.output) || "(no output)", "```"].join("\n");
/** Exit codes that are outcomes, not failures: extract 3 = the IR has questions for a person. */
const stepOk = (step: Step, code: number) => code === 0 || (step === "extract" && code === 3);

export async function paperclipRun(o: { root: string; api: PaperclipApi; runStep: StepRunner; runId: string; agentId: string; companyId: string; maxSteps?: number }): Promise<string> {
  const { api } = o;
  const ctx = (await api.getRun(o.runId)).contextSnapshot ?? {};
  if (!ctx.issueId) return "no issue in this run's context; nothing to do";
  const issue = await api.getIssue(ctx.issueId);
  const ticket = issue.title.match(/^([A-Z][A-Z0-9]+-\d+)\b/)?.[1];
  if (!ticket) {
    await api.comment(issue.id, "No ticket key at the start of the title (e.g. `AIT-1: ...`), so ai-sdlc has nothing to run for this issue.");
    return "no ticket key";
  }
  await api.checkout(issue.id, o.agentId);

  const approvals = await api.approvals(issue.id);
  const decided = approvals.filter((a) => a.decidedAt && a.payload?.ticket === ticket).sort((a, b) => (a.decidedAt! < b.decidedAt! ? 1 : -1))[0];
  const wokenByDecision = ctx.wakeReason?.startsWith("approval_") && decided;
  if (wokenByDecision && decided.status === "rejected") {
    await api.comment(issue.id, `The board rejected "${decided.payload.title}"${decided.decisionNote ? `: ${decided.decisionNote}` : ""}. Parked in the backlog; reassign the issue to resume.`);
    await api.setStatus(issue.id, "backlog");
    return "rejected; parked";
  }
  let prApproved = Boolean(wokenByDecision && decided.status === "approved" && decided.payload.action === "pr");
  const mergeApproved = Boolean(wokenByDecision && decided.status === "approved" && decided.payload.action === "merge");

  const waitFor = async (action: PersonAction, text: string) => {
    const pending = approvals.some((a) => a.status === "pending" && a.payload?.action === action && a.payload?.ticket === ticket);
    if (!pending) {
      await api.requestApproval(issue.id, { action, ticket, title: `${ticket}: ${text}` }, o.companyId, o.agentId);
      await api.comment(issue.id, `Waiting for a person: ${text}`);
    }
    await api.setStatus(issue.id, "blocked");
    return `waiting for a person (${action})`;
  };

  for (let i = 0; i < (o.maxSteps ?? 6); i++) {
    const next = nextAction(o.root, ticket);
    if (next.kind === "review") {
      // Paperclip refuses in_review without an owner for the next action, so review is a board approval too.
      if (mergeApproved) {
        await api.comment(issue.id, `The board confirmed ${next.url} is reviewed and merged. Done.`);
        await api.setStatus(issue.id, "done");
        return "done";
      }
      return waitFor("merge", `Review and merge ${next.url} on GitHub (a person approves the PR itself), then approve here to close this issue.`);
    }
    const step: Step | undefined = next.kind === "step" ? next.step : next.action === "pr" && prApproved ? "pr" : undefined;
    if (!step) return waitFor(next.kind === "person" ? next.action : "failure", next.kind === "person" ? next.text : "");
    if (step === "pr") prApproved = false; // one approval opens one PR
    await api.setStatus(issue.id, "in_progress");
    const r = await o.runStep(step, ticket);
    await api.comment(issue.id, stepComment(step, ticket, r));
    if (!stepOk(step, r.code)) return waitFor("failure", `\`ai-sdlc ${step} ${ticket}\` failed (exit ${r.code}; output above). A developer looks at it, then approves to retry.`);
  }
  return waitFor("failure", `Stopped after ${o.maxSteps ?? 6} steps without reaching a person or a PR. A developer looks at it, then approves to retry.`);
}

/** Mirror ready Jira tickets into Paperclip issues assigned to the runner (one per ticket; titles start with the key). */
export async function paperclipSync(o: {
  api: PaperclipApi; jira: { search(jql: string): Promise<{ key: string; summary: string }[]> };
  project: string; readyStatus: string; companyId: string; agentId: string; jiraUrl?: string; dryRun?: boolean;
}): Promise<{ created: string[]; existing: string[] }> {
  const tickets = await o.jira.search(`project = ${o.project} AND status = "${o.readyStatus}" ORDER BY created ASC`);
  const have = new Set((await o.api.listIssues(o.companyId)).map((i) => i.title.match(/^([A-Z][A-Z0-9]+-\d+)\b/)?.[1]).filter(Boolean));
  const created: string[] = [];
  const existing: string[] = [];
  for (const t of tickets) {
    if (have.has(t.key)) { existing.push(t.key); continue; }
    created.push(t.key);
    if (!o.dryRun) await o.api.createIssue({
      companyId: o.companyId, assigneeAgentId: o.agentId, title: `${t.key}: ${t.summary}`,
      description: `Mirror of Jira ${t.key}${o.jiraUrl ? ` (${o.jiraUrl}/browse/${t.key})` : ""}. Jira is the source of truth; ai-sdlc runs it and reports here.`,
    });
  }
  return { created, existing };
}

/** The Paperclip REST API. Inside a run: the run's key and id; outside (sync): a board key, or none in local_trusted mode. */
export class HttpPaperclip implements PaperclipApi {
  constructor(private base: string, private key?: string, private runId?: string, private fetchImpl: typeof fetch = fetch) {}
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, "")}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}), ...(this.runId ? { "x-paperclip-run-id": this.runId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Paperclip ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  getRun(id: string) { return this.call<{ contextSnapshot?: { issueId?: string; wakeReason?: string } }>("GET", `/heartbeat-runs/${id}`); }
  getIssue(id: string) { return this.call<{ id: string; identifier?: string; title: string; status: string }>("GET", `/issues/${id}`); }
  async checkout(issueId: string, agentId: string) { await this.call("POST", `/issues/${issueId}/checkout`, { agentId, expectedStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked"] }); }
  async comment(issueId: string, body: string) { await this.call("POST", `/issues/${issueId}/comments`, { body }); }
  async setStatus(issueId: string, status: string) { await this.call("PATCH", `/issues/${issueId}`, { status }); }
  async approvals(issueId: string) { const r = await this.call<Approval[] | { approvals: Approval[] }>("GET", `/issues/${issueId}/approvals`); return Array.isArray(r) ? r : r.approvals ?? []; }
  async requestApproval(issueId: string, payload: Approval["payload"], companyId: string, agentId: string) {
    await this.call("POST", `/companies/${companyId}/approvals`, { type: "request_board_approval", requestedByAgentId: agentId, issueIds: [issueId], payload });
  }
  async listIssues(companyId: string) { const r = await this.call<{ id: string; title: string }[] | { issues: { id: string; title: string }[] }>("GET", `/companies/${companyId}/issues`); return Array.isArray(r) ? r : r.issues ?? []; }
  createIssue(o: { companyId: string; title: string; description: string; assigneeAgentId: string }) {
    return this.call<{ id: string; identifier?: string }>("POST", `/companies/${o.companyId}/issues`, { title: o.title, description: o.description, assigneeAgentId: o.assigneeAgentId, status: "todo" });
  }
}

/** Run one ai-sdlc step as its own process, exactly as a developer would from the command line. */
export function cliStepRunner(root: string, env: NodeJS.ProcessEnv = process.env): StepRunner {
  return (step, ticket) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(WORKFLOW_ROOT, "bin", "ai-sdlc.mjs"), step, ticket], { cwd: root, env: { ...env, TMPDIR: "/tmp" } });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}
