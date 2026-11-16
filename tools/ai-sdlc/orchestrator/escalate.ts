// Escalation: the attempt cap was hit (or the budget ran out). A developer takes over with the
// full report: what the unit was, every attempt's gate results, and where the work is.
import { join } from "node:path";
import type { Config } from "./config.ts";
import { cliHint } from "./config.ts";
import { Jira } from "./jira.ts";
import { moveTicket } from "./jira-sync.ts";
import { emit } from "./telemetry.ts";
import { writeFileEnsured } from "./util.ts";

export interface EscalationInput {
  root: string;
  ticket: string;
  unit: string;
  runId: string;
  reason: string;
  attempts: { attempt: number; report: string; agentSummary?: string }[];
  branch?: string;
  telemetryFile?: string;
  /** When given, the ticket also moves to jira.stages.escalated. */
  cfg?: Config;
}

export type Escalator = (e: EscalationInput) => Promise<string>;

export function escalationMarkdown(e: EscalationInput): string {
  return [
    `# Escalation: ${e.unit} (${e.ticket})`,
    ``,
    `**Reason:** ${e.reason}`,
    `**Run:** ${e.runId}`,
    e.branch ? `**Work in progress:** branch \`${e.branch}\`` : "",
    ``,
    `A developer takes over this unit: finish it on its branch (${e.branch ?? "the unit branch"}), commit, then run \`${cliHint(`gates ${e.ticket} ${e.unit}`, e.root)}\`. The same gates run on the change, with no agent; when they pass, the unit merges and QA can run. Each attempt below lists the checks that failed; they are facts from the check scripts.`,
    ``,
    ...e.attempts.flatMap((a) => [
      `## Attempt ${a.attempt}`,
      a.agentSummary ? `Agent's final message (unverified):\n\n> ${a.agentSummary.slice(0, 1500).replace(/\n/g, "\n> ")}\n` : "",
      "```",
      a.report.slice(0, 12000),
      "```",
      ``,
    ]),
  ].filter((l) => l !== "").join("\n") + "\n";
}

export const defaultEscalator: Escalator = async (e) => {
  const path = join(e.root, ".ai-sdlc", "reports", e.ticket, `${e.unit}-escalation.md`);
  const md = escalationMarkdown(e);
  writeFileEnsured(path, md);
  await emit(e.root, { event: "escalation", run_id: e.runId, ticket: e.ticket, unit: e.unit, status: "escalated", output_ref: `report:${path}`, detail: { reason: e.reason, attempts: e.attempts.length } }, e.telemetryFile);
  const jira = Jira.fromEnv();
  if (jira) {
    try {
      await jira.addComment(e.ticket, `## AI-SDLC escalation: ${e.unit}\n\n${e.reason}\n\nFull report: ${path} (branch ${e.branch ?? "n/a"}).\n\nLast attempt:\n\`\`\`\n${(e.attempts.at(-1)?.report ?? "").slice(0, 4000)}\n\`\`\``);
    } catch (err) {
      process.stderr.write(`escalation: Jira comment failed: ${String(err)}\n`);
    }
    if (e.cfg) {
      const moved = await moveTicket(e.root, e.ticket, "escalated", e.cfg, jira).catch((err) => `failed: ${String(err)}`);
      process.stderr.write(`escalation: Jira status ${moved}\n`);
    }
  }
  return path;
};
