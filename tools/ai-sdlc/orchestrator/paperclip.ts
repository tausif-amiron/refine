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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { WORKFLOW_ROOT } from "./config.ts";
import { commitAll } from "./git.ts";
import { openIrQuestions, parseCommand, readAdvice, type Command } from "./advise.ts";
import { stableStringify } from "./util.ts";

export type Step = "extract" | "suggest" | "plan" | "run" | "pr";
export interface QuestionOption { id: string; label: string; description?: string }
export interface AskedQuestion { id: string; prompt: string; helpText?: string; options?: QuestionOption[] }
export interface IssueComment { id: string; body: string; createdAt: string; authorUserId?: string | null; authorAgentId?: string | null }
/** Run a developer's /command (or a tutor reply) from a comment; undefined when the comment is not for the workflow. */
export type CommandRunner = (ticket: string, command: Command | undefined, text: string) => Promise<{ reply: string } | undefined>;
export interface Approval { id: string; status: string; decidedAt?: string; decisionNote?: string; payload: { action: string; ticket: string; title: string } }
export interface PaperclipApi {
  getRun(id: string): Promise<{ contextSnapshot?: { issueId?: string; wakeReason?: string; wakeCommentId?: string } }>;
  getIssue(id: string): Promise<{ id: string; identifier?: string; title: string; status: string }>;
  checkout(issueId: string, agentId: string): Promise<void>;
  comment(issueId: string, body: string): Promise<void>;
  setStatus(issueId: string, status: string): Promise<void>;
  approvals(issueId: string): Promise<Approval[]>;
  requestApproval(issueId: string, payload: Approval["payload"], companyId: string, agentId: string): Promise<void>;
  listIssues(companyId: string): Promise<{ id: string; title: string }[]>;
  createIssue(o: { companyId: string; title: string; description: string; assigneeAgentId?: string; projectId?: string; status?: string }): Promise<{ id: string; identifier?: string }>;
  interactions(issueId: string): Promise<Interaction[]>;
  askQuestions(issueId: string, title: string, questions: AskedQuestion[]): Promise<void>;
  listComments(issueId: string): Promise<IssueComment[]>;
  getComment(issueId: string, commentId: string): Promise<IssueComment>;
  withdraw(issueId: string, interactionId: string, reason: string): Promise<void>;
}
export type StepRunner = (step: Step, ticket: string) => Promise<{ code: number; output: string }>;
export interface Interaction {
  id: string; kind: string; status: string; createdAt?: string;
  payload?: { questions?: { id: string; prompt: string }[] };
  result?: { version: 1; answers: { questionId: string; optionIds: string[]; otherText?: string | null }[]; outcome?: string; reason?: string | null; cancelled?: true };
}
/**
 * The environment for one step. The GitHub token (AI_SDLC_GH_TOKEN, bound from a Paperclip secret) reaches only `pr`,
 * as GH_TOKEN; every other step, and so every agent, runs without it.
 */
export function stepEnv(step: Step, vars: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...vars, TMPDIR: "/tmp" };
  const token = out.AI_SDLC_GH_TOKEN;
  delete out.AI_SDLC_GH_TOKEN;
  delete out.GH_TOKEN;
  if (step === "pr" && token) out.GH_TOKEN = token;
  return out;
}

const OWN_ANSWER: QuestionOption = { id: "answer", label: "Your own answer" };
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** The open IR questions (ids Q-<n>), each with the advisor's options (recommended first) and a free-text answer. */
function openQuestions(root: string, ticket: string): AskedQuestion[] {
  const advice = readAdvice(root, ticket);
  return openIrQuestions(root, ticket).map((q) => {
    const a = advice?.questions.find((x) => x.question === q.id);
    const order = a ? [a.recommended, ...a.options.map((_, i) => i).filter((i) => i !== a.recommended)] : [];
    const options: QuestionOption[] = order.map((i) => {
      const o = a!.options[i];
      return {
        id: `opt-${i}`,
        label: clip(`${o.answer}${i === a!.recommended ? " (Recommended)" : ""}`, 1000),
        description: clip([`Why: ${o.why}`, `Evidence: ${o.evidence.join(", ")}`, `If wrong: ${o.if_wrong}`, `Confidence: ${o.confidence}`].join("\n"), 4000),
      };
    });
    const help = [q.affects && `Affects: ${q.affects}`, q.if_wrong && `If answered wrongly: ${q.if_wrong}`,
      `Question it before you pick: comment \`/why ${q.id}\`, \`/grill ${q.id}\` or \`/tutor ${q.id}\` (\`/help\` lists them).`].filter(Boolean).join("\n");
    return { id: q.id, prompt: q.q, helpText: help, options: [...options, OWN_ANSWER] };
  });
}

/** Write answers into the IR (by Q-<n>): a picked option's answer, plus the developer's note; or their own text. */
function applyAnswers(root: string, ticket: string, answers: { questionId: string; optionIds: string[]; otherText?: string | null }[]): number {
  const path = join(root, "ir", `${ticket}.ir.json`);
  const ir = JSON.parse(readFileSync(path, "utf8")) as { questions: { answer?: string }[] };
  const advice = readAdvice(root, ticket);
  let n = 0;
  for (const a of answers) {
    const i = Number(a.questionId.replace(/^Q-/, "")) - 1;
    const note = (a.otherText ?? "").trim();
    const picked = a.optionIds.map((id) => id.match(/^opt-(\d+)$/)?.[1]).filter(Boolean).map((k) => advice?.questions.find((q) => q.question === a.questionId)?.options[Number(k)]?.answer).filter(Boolean) as string[];
    const text = picked.length ? `${picked.join("; ")}${note ? `. Note: ${note}` : ""}` : note;
    if (ir.questions[i] && !ir.questions[i].answer && text) { ir.questions[i].answer = text; n++; }
  }
  writeFileSync(path, stableStringify(ir));
  return n;
}

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

export async function paperclipRun(o: { root: string; api: PaperclipApi; runStep: StepRunner; runId: string; agentId: string; companyId: string; maxSteps?: number; commit?: (message: string) => void; isMerged?: (url: string) => Promise<boolean | undefined>;
  /** Answer a developer's /command typed as a comment (orchestrator/advise.ts). */
  runCommand?: CommandRunner;
  /** Put the working copy on the ticket's branch (several tickets share one checkout); throws when it cannot. */
  useBranch?: (ticket: string) => void }): Promise<string> {
  const { api } = o;
  const ctx = (await api.getRun(o.runId)).contextSnapshot ?? {};
  if (!ctx.issueId) return "no issue in this run's context; nothing to do";
  const issue = await api.getIssue(ctx.issueId);
  const key = issue.title.match(/^([A-Z][A-Z0-9]+-\d+)\b/)?.[1];
  if (!key) {
    await api.comment(issue.id, "No ticket key at the start of the title (e.g. `AIT-1: ...`), so ai-sdlc has nothing to run for this issue.");
    return "no ticket key";
  }
  const ticket: string = key;
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

  // Everything below reads the ticket's files, so the checkout must be on its branch first.
  try { o.useBranch?.(ticket); } catch (e) {
    return waitFor("failure", `Could not switch to ${ticket}'s branch: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }

  let suggestTried = false;
  try {
    // Woken by a person's comment: a /command (or a reply in a /tutor session) gets its answer on the issue.
    if (ctx.wakeCommentId && o.runCommand) {
      const c = await api.getComment(issue.id, ctx.wakeCommentId).catch(() => undefined);
      if (c && c.authorUserId && !c.authorAgentId) {
        const r = await o.runCommand(ticket, parseCommand(c.body), c.body);
        if (r) await api.comment(issue.id, r.reply);
      }
    }
    return await moveForward();
  } catch (e) {
    // A crashed run leaves the issue locked in Paperclip's execution recovery (RT-1: no wake, retry or comment
    // restarted it). Report the error and wait for a person instead; if even that fails, fail loudly.
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
    try {
      return await waitFor("failure", `The run stopped on an error: ${msg}. A developer looks at it, then approves to retry.`);
    } catch { throw e; }
  }

  async function moveForward(): Promise<string> {
  for (let i = 0; i < (o.maxSteps ?? 6); i++) {
    const next = nextAction(o.root, ticket);
    if (next.kind === "review") {
      // Paperclip refuses in_review without an owner for the next action, so review is a board approval too.
      if (mergeApproved) {
        // Code decides, not the click: an approval only closes the issue when GitHub says the PR merged (RT-3's was
        // approved 21 seconds after it opened, unmerged).
        const merged = await (o.isMerged ?? githubMerged)(next.url).catch(() => undefined);
        if (merged) {
          await api.comment(issue.id, `${next.url} is merged on GitHub. Done.`);
          await api.setStatus(issue.id, "done");
          return "done";
        }
        await api.comment(issue.id, merged === false
          ? `${next.url} is still open on GitHub (not merged), so this issue stays open. Approve again after merging it.`
          : `I could not check ${next.url} on GitHub, so this issue stays open. Approve again once it is merged.`);
      }
      return waitFor("merge", `Review and merge ${next.url} on GitHub (a person approves the PR itself), then approve here to close this issue.`);
    }
    if (next.kind === "person" && next.action === "answers") {
      let open = openQuestions(o.root, ticket);
      if (open.length) {
        const asked = (await api.interactions(issue.id)).filter((i) => i.kind === "ask_user_questions");
        const same = (i: Interaction) => JSON.stringify((i.payload?.questions ?? []).map((q) => q.prompt)) === JSON.stringify(open.map((q) => q.prompt));
        const mine = asked.filter(same);
        // Recommended answers first (once, before the questions are first asked); without them, ask anyway.
        if (!mine.length && !readAdvice(o.root, ticket) && !suggestTried) {
          suggestTried = true;
          await api.setStatus(issue.id, "in_progress");
          const r = await o.runStep("suggest", ticket);
          await api.comment(issue.id, stepComment("suggest", ticket, r));
          open = openQuestions(o.root, ticket);
          continue;
        }
        // A set the runner withdrew itself (after a comment) is not a person's response.
        const answered = [...mine].filter((i) => i.result && i.result.outcome !== "withdrawn").sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1))[0];
        if (answered?.result) {
          const r = answered.result;
          if (r.cancelled || r.outcome || !r.answers.length) {
            await api.comment(issue.id, `The questions were ${r.outcome ?? "cancelled"}${r.reason ? `: ${r.reason}` : ""}. Parked in the backlog; reassign the issue to resume.`);
            await api.setStatus(issue.id, "backlog");
            return "questions not answered; parked";
          }
          const n = applyAnswers(o.root, ticket, r.answers);
          (o.commit ?? ((m: string) => commitAll(o.root, m)))(`docs(ir): answers for ${ticket} from Paperclip\n\n${n} answer(s) given in Paperclip.\n\nTicket: ${ticket}`);
          await api.comment(issue.id, `Recorded ${n} answer(s) from Paperclip in ir/${ticket}.ir.json.`);
          continue;
        }
        // Paperclip treats a set as history once a person comments after it: it no longer holds the issue. Withdraw
        // such sets and ask again, so the questions stay open and the issue waits for them.
        const comments = await api.listComments(issue.id).catch(() => [] as IssueComment[]);
        const lastPerson = comments.filter((c) => c.authorUserId && !c.authorAgentId).map((c) => c.createdAt).sort().at(-1);
        const pending = mine.filter((i) => i.status === "pending");
        const active = pending.find((i) => !lastPerson || (i.createdAt ?? "") > lastPerson);
        if (!active) {
          for (const i of pending) await api.withdraw(issue.id, i.id, "Asked again after a comment.").catch(() => undefined);
          await api.askQuestions(issue.id, `${ticket}: questions before the build`, open);
          if (!mine.length) await api.comment(issue.id, `Waiting for a person: answer the ${open.length} question(s) in the Questions panel of this issue. Each has a recommended answer; question it first with \`/why Q-n\`, \`/grill Q-n\` or \`/tutor Q-n\` as a comment (\`/help\`). The build starts when they are answered.`);
        }
        await api.setStatus(issue.id, "blocked");
        return "waiting for answers";
      }
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
}

/** Is this GitHub PR merged? Asks GitHub's public API (the fork is public); undefined when it cannot tell. */
export async function githubMerged(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean | undefined> {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return undefined;
  const r = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return undefined;
  const j = (await r.json()) as { merged?: boolean };
  return typeof j.merged === "boolean" ? j.merged : undefined;
}

/**
 * Mirror ready Jira tickets into Paperclip issues (one per ticket; titles start with the key). By default an issue lands
 * unassigned in the backlog of the repo's project and a person starts it by assigning it to the runner; `autoStart`
 * assigns it at once. Safe to run on a schedule: tickets already in Paperclip are skipped.
 */
export async function paperclipSync(o: {
  api: PaperclipApi; jira: { search(jql: string): Promise<{ key: string; summary: string }[]> };
  project: string; readyStatus: string; companyId: string; agentId: string; projectId?: string; autoStart?: boolean; jiraUrl?: string; dryRun?: boolean;
}): Promise<{ created: string[]; existing: string[] }> {
  const tickets = await o.jira.search(`project = ${o.project} AND status = "${o.readyStatus}" ORDER BY created ASC`);
  const have = new Set((await o.api.listIssues(o.companyId)).map((i) => i.title.match(/^([A-Z][A-Z0-9]+-\d+)\b/)?.[1]).filter(Boolean));
  const created: string[] = [];
  const existing: string[] = [];
  for (const t of tickets) {
    if (have.has(t.key)) { existing.push(t.key); continue; }
    created.push(t.key);
    if (!o.dryRun) await o.api.createIssue({
      companyId: o.companyId, title: `${t.key}: ${t.summary}`, projectId: o.projectId,
      ...(o.autoStart ? { assigneeAgentId: o.agentId, status: "todo" } : { status: "backlog" }),
      description: `Mirror of Jira ${t.key}${o.jiraUrl ? ` (${o.jiraUrl}/browse/${t.key})` : ""}. Jira is the source of truth; ai-sdlc runs it and reports here.${o.autoStart ? "" : " To start it, assign this issue to the repository's AI-SDLC agent."}`,
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
  async interactions(issueId: string) {
    const r = await this.call<Interaction[] | { interactions: Interaction[] }>("GET", `/issues/${issueId}/interactions`);
    return Array.isArray(r) ? r : r.interactions ?? [];
  }
  async listComments(issueId: string) { const r = await this.call<IssueComment[] | { comments: IssueComment[] }>("GET", `/issues/${issueId}/comments`); return Array.isArray(r) ? r : r.comments ?? []; }
  getComment(issueId: string, commentId: string) { return this.call<IssueComment>("GET", `/issues/${issueId}/comments/${commentId}`); }
  async withdraw(issueId: string, interactionId: string, reason: string) { await this.call("POST", `/issues/${issueId}/interactions/${interactionId}/withdraw`, { reason }); }
  async askQuestions(issueId: string, title: string, questions: AskedQuestion[]) {
    await this.call("POST", `/issues/${issueId}/interactions`, {
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", title,
      payload: {
        version: 1, title, submitLabel: "Send answers",
        questions: questions.map((q) => ({
          id: q.id, prompt: q.prompt, ...(q.helpText ? { helpText: q.helpText } : {}), selectionMode: "single", required: true,
          options: (q.options?.length ? q.options : [OWN_ANSWER]).map((op) => ({ id: op.id, label: op.label, ...(op.description ? { description: op.description } : {}), ...(op.id === OWN_ANSWER.id ? { freeText: true } : {}) })),
        })),
      },
    });
  }
  createIssue(o: { companyId: string; title: string; description: string; assigneeAgentId?: string; projectId?: string; status?: string }) {
    return this.call<{ id: string; identifier?: string }>("POST", `/companies/${o.companyId}/issues`, {
      title: o.title, description: o.description, status: o.status ?? "todo",
      ...(o.assigneeAgentId ? { assigneeAgentId: o.assigneeAgentId } : {}), ...(o.projectId ? { projectId: o.projectId } : {}),
    });
  }
}

/** Run one ai-sdlc step as its own process, exactly as a developer would from the command line. */
export function cliStepRunner(root: string, env: NodeJS.ProcessEnv = process.env): StepRunner {
  return (step, ticket) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(WORKFLOW_ROOT, "bin", "ai-sdlc.mjs"), step, ticket], { cwd: root, env: stepEnv(step, env) });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}
