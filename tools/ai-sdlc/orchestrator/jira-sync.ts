// What the scripts write back to the Jira ticket after extraction: the answers once they are recorded (with the
// planned units), and the pull request once it opens. Code posts these, never an agent. A ticket read from a file
// (--ticket-file) gets nothing. Each kind of comment is posted again only when its text changes, so re-running a
// step does not repeat it. The same rules apply to moving the ticket between statuses (moveTicket).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { IR, Plan } from "./types.ts";
import { writeFileEnsured } from "./util.ts";

export interface CommentSink { addComment(key: string, text: string): Promise<void> }
export interface StatusSink { transition(key: string, toStatus: string): Promise<boolean> }
/** posted: comment kind → hash of its text. moved: pipeline stage → the status the ticket was moved to. */
interface TicketRecord { source: "jira" | "file"; posted: Record<string, string>; moved?: Record<string, string> }

const recordPath = (root: string, ticket: string) => join(root, ".ai-sdlc", "tickets", `${ticket}.json`);

function readRecord(root: string, ticket: string): TicketRecord | undefined {
  const p = recordPath(root, ticket);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as TicketRecord) : undefined;
}

const writeRecord = (root: string, ticket: string, rec: TicketRecord) => writeFileEnsured(recordPath(root, ticket), JSON.stringify(rec, null, 2) + "\n");

/** Written at extraction: where the ticket came from. Only Jira tickets get comments and status moves later. */
export function recordTicketSource(root: string, ticket: string, source: "jira" | "file"): void {
  const prev = readRecord(root, ticket);
  writeRecord(root, ticket, { source, posted: prev?.posted ?? {}, ...(prev?.moved ? { moved: prev.moved } : {}) });
}

/**
 * Points in the pipeline where the ticket moves in Jira:
 * - needsAnswers: extraction raised questions or unplaced text (jira.needsAnswersStatus).
 * - answered: the plan was made after the ticket had been moved to needsAnswers; back to jira.readyStatus.
 * - escalated: a unit hit its attempt or budget cap and a developer takes over (jira.stages.escalated).
 * - inReview: the pull request opened (jira.stages.inReview).
 * - released: the change reached production through the release workflow (jira.stages.released).
 */
export type Stage = "needsAnswers" | "answered" | "escalated" | "inReview" | "released";

export function stageStatus(cfg: Config, stage: Stage): string {
  if (stage === "needsAnswers") return cfg.jira.needsAnswersStatus ?? "";
  if (stage === "answered") return cfg.jira.readyStatus ?? "";
  return cfg.jira.stages?.[stage] ?? "";
}

/**
 * Move the ticket to the status configured for this stage. Like comments, only tickets that came from Jira move,
 * and each stage moves the ticket once. "released" is called from CI, where no ticket record exists, so it moves
 * any ticket key it is given. A status that is not set, or that the ticket's workflow cannot reach from where it
 * is, leaves the ticket where it is and says so; it never fails the step.
 */
export async function moveTicket(root: string, ticket: string, stage: Stage, cfg: Config, jira: StatusSink | undefined): Promise<string> {
  const status = stageStatus(cfg, stage);
  if (!status) return `skipped: no status set for "${stage}"`;
  if (!jira) return "skipped: no Jira credentials";
  const rec = readRecord(root, ticket);
  if (stage !== "released" && rec?.source !== "jira") return "skipped: ticket not from Jira";
  if (stage === "answered" && !rec?.moved?.needsAnswers) return "skipped: ticket was not waiting for answers";
  if (rec?.moved?.[stage] === status) return `skipped: already moved to "${status}"`;
  if (!(await jira.transition(ticket, status))) return `skipped: the ticket's workflow has no transition to "${status}" from its current status`;
  if (rec) {
    const moved = { ...rec.moved, [stage]: status };
    if (stage === "answered") delete moved.needsAnswers; // a later extraction with new questions moves it again
    writeRecord(root, ticket, { ...rec, moved });
  }
  return `moved to "${status}"`;
}

export async function postOnce(root: string, ticket: string, kind: string, text: string, jira: CommentSink | undefined): Promise<string> {
  const rec = readRecord(root, ticket);
  if (!jira || rec?.source !== "jira") return "skipped: ticket not from Jira";
  const hash = createHash("sha256").update(text).digest("hex");
  if (rec.posted[kind] === hash) return "skipped: already posted";
  await jira.addComment(ticket, text);
  rec.posted[kind] = hash;
  writeFileEnsured(recordPath(root, ticket), JSON.stringify(rec, null, 2) + "\n");
  return "posted";
}

/** Posted when the plan is made: every question with its answer, and the units the build will run. */
export function answersComment(ir: IR, plan: Plan): string {
  return [
    `## Answers recorded and plan made`,
    ir.questions.length
      ? ir.questions.map((q, i) => `${i + 1}. ${q.q}\n   Answer: ${q.answer ?? "(not answered yet)"}`).join("\n")
      : "No questions were raised.",
    `## Units`,
    plan.units.map((u) => `- ${u.id} (${u.kind})`).join("\n"),
    `The IR file ir/${ir.ticket}.ir.json is canonical. Change an answer there, not here.`,
  ].join("\n\n");
}

export function prComment(url: string, base: string): string {
  return [`## Pull request opened`, `${url} into \`${base}\`.`, `A person approves and merges it. The review agent comments only.`].join("\n\n");
}
