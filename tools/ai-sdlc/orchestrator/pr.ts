// Open (or update) the PR for a ticket with the evidence the approver reads: IR summary, units,
// QA report, blind score. Uses the gh CLI. Refuses if the build or QA has not passed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cliHint, workflowRel, type Config } from "./config.ts";
import { loadState, type TicketState } from "./attempts.ts";
import { baseBranchOf, git, ticketBranch } from "./git.ts";
import { telemetryFile } from "./telemetry.ts";
import { loadProfile, profilesFor, readScripts, scriptRuns, type Profile } from "../checks/hooks/profile.mjs";
import { loadIr } from "./ir.ts";
import { loadOwed, openFrom } from "./owed.ts";
import { loadPlan, ticketChecks } from "./run.ts";
import { scoreMarkdown, type ScoreResult } from "./score.ts";
import type { IR, Plan } from "./types.ts";
import { sh, writeFileEnsured } from "./util.ts";

export const PR_SCORE_START = "<!-- ai-sdlc:score:start -->";
export const PR_SCORE_END = "<!-- ai-sdlc:score:end -->";

export interface PrFacts {
  base: string;
  gatesRun: string[];           // gates every unit went through
  notGated: { script: string; partial?: string }[];   // repo scripts no check runs, or runs only partly
  scoreDone: boolean;
  scoreReason?: string;         // why the blind score was not run
  attempts: string[];           // one line per failed attempt
  mutation?: { unit: string; killed: number; total: number }[];  // per unit, from its passing gates
  pins?: { unit: string; count: number }[];                      // per unit, from its seen-red gate
  external?: { unit: string; summary: string }[];                // per unit, the repo's own mutation tool
  decisions?: { q: string; answer: string }[];                   // clarification questions answered in the IR
  notes?: string;                                                // .ai-sdlc/reports/<T>/notes.md, written by people
  installParts?: string[];                                       // what the workflow install on this branch contains
  costUsd?: number;
  workflowFiles: number;        // files of the workflow install carried by this branch
  stack?: StackInfo;             // set when the base branch is itself a PR's head
}

export function prBody(o: { ir: IR; plan: Plan; unitLines: string[]; qaSummary: string; score: string; openOwed: number; facts?: PrFacts }): string {
  const { ir, facts } = o;
  const verification = facts ? [
    `### What the workflow checked`,
    `- Every unit: ${facts.gatesRun.join(", ")}.`,
    ...facts.notGated.map((n) => n.partial ? `- **Partly gated:** \`${n.script}\`: ${n.partial}.` : `- **Not gated:** \`${n.script}\` (a project script that no check runs).`),
    ...(facts.mutation ?? []).map((m) => m.total
      ? `- Mutation, \`${m.unit}\`: ${m.killed} of ${m.total} mutants killed.`
      : `- **Mutation, \`${m.unit}\`: not tested by mutation** (no mutation rule applied to the changed lines).`),
    ...(facts.external ?? []).map((e) => `- Repo mutation catalogue, \`${e.unit}\`: ${e.summary}.`),
    ...(facts.pins ?? []).filter((p) => p.count).map((p) => `- Pins, \`${p.unit}\`: ${p.count} tests guard behaviour that must stay unchanged; they pass before and after the change.`),
    `- Blind score: ${facts.scoreDone ? "done (above)" : `not run${facts.scoreReason ? ` (${facts.scoreReason})` : ""}`}.`,
    ``,
    ...(facts.scoreDone ? [] : personChecks(ir)),
    ...(facts.decisions?.length ? [`### Decisions (questions answered before the build)`, ...facts.decisions.map((d) => `- **Q:** ${d.q}\n  **A:** ${d.answer}`), ``] : []),
    ...(facts.notes ? [`### Notes from the people involved`, facts.notes.trim(), ``] : []),
    `### Attempts`,
    ...(facts.attempts.length ? facts.attempts.map((a) => `- ${a}`) : ["- Every unit passed on its first attempt."]),
    ``,
  ] : [];
  const stackWarning = facts?.stack ? [stackMessage(facts.stack, "markdown"), ``] : [];
  const warning = facts && facts.workflowFiles
    ? [`> **This branch also carries ${facts.workflowFiles} workflow files** (the AI-SDLC install: ${(facts.installParts ?? []).join(", ")}). Consider landing the install in its own PR so this one shows only the ticket's change.`, ``]
    : [];
  return [
    `## ${ir.ticket}: ${ir.title}`,
    ``,
    `Built by the AI-SDLC loop. **A person approves this PR.** The review agent comments only.`,
    ``,
    ...stackWarning,
    ...warning,
    PR_SCORE_START,
    o.score,
    PR_SCORE_END,
    ``,
    `### Sealed acceptance criteria`,
    ...ir.sealed_acceptance_criteria.map((c) => `- **${c.id}** ${c.text.replace(/\n/g, "\n  ")}`),
    ``,
    ...verification,
    `### Units`,
    "```",
    ...o.unitLines,
    "```",
    ``,
    `### QA`,
    o.qaSummary,
    ``,
    `### Evidence`,
    `- IR: \`ir/${ir.ticket}.ir.json\` (sealed ${ir.sealed_hash.slice(7, 19)})`,
    `- Plan and contracts: \`ir/${ir.ticket}.plan.json\`, \`contracts/\``,
    `- Open owed.yaml entries: ${o.openOwed}`,
    facts?.costUsd !== undefined ? `- Agent cost for this ticket: $${facts.costUsd.toFixed(2)}` : "",
    ``,
    `Ticket: ${ir.ticket}`,
    ``,
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ].filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

/** Words that mark a criterion as being about what a person sees in the running product. */
const SEEN = /\b(screens?|pages?|profiles?|panels?|views?|buttons?|links?|forms?|modals?|menus?|tabs?|reads|shows?|displays?|sees?|opens?|clicks?|visible|appears?)\b/i;

/** When the blind score did not run: the criteria a person has to look at in the product (by wording). */
export function personChecks(ir: IR): string[] {
  const seen = ir.sealed_acceptance_criteria.filter((c) => SEEN.test(c.text));
  return [
    `### Needs a person before approving`,
    `The workflow did not observe the running product.${seen.length ? " These criteria describe what a person sees:" : " No criterion is worded as something a person sees; spot-check the change against the criteria."}`,
    ...seen.map((c) => `- [ ] **${c.id}** ${c.text.replace(/\n/g, " ")}`),
    ``,
  ];
}

export interface StackInfo {
  base: string;                  // the branch this PR targets
  parent?: { number: number; base: string; state: "OPEN" | "MERGED" | "CLOSED" };  // the PR whose head is `base`
  recordedBase?: string;         // where the workflow recorded `base` was cut from
}

type Gh = (args: string) => { code: number; stdout: string; stderr?: string };

/** gh for this repo's PRs: names `pr.repo` on every call when it is set, so a fork setup never reaches upstream. */
export function ghFor(root: string, cfg: Config, gh?: Gh): Gh {
  const run: Gh = gh ?? ((a) => sh(`gh ${a}`, { cwd: root }));
  const repo = cfg.pr?.repo;
  return repo ? (a) => run(`${a} --repo '${repo}'`) : run;
}

/**
 * Is this PR stacked: does its base branch have a PR of its own (or was it cut by the workflow from another branch)?
 * A stacked PR merged after the PR below it has already merged lands on a branch nothing merges any more, which is
 * how FA-001 (#2) missed tausif/phase2-prepare.
 */
export function stackInfo(root: string, base: string, gh: Gh = (a) => sh(`gh ${a}`, { cwd: root })): StackInfo | undefined {
  const recordedBase = git(root, `config --get 'branch.${base}.ai-sdlc-base'`).stdout.trim() || undefined;
  const r = gh(`pr list --head '${base}' --state all --limit 5 --json number,baseRefName,state`);
  let parent: StackInfo["parent"];
  if (r.code === 0) {
    try {
      const prs = JSON.parse(r.stdout || "[]") as { number: number; baseRefName: string; state: "OPEN" | "MERGED" | "CLOSED" }[];
      const pick = prs.find((p) => p.state === "OPEN") ?? prs.find((p) => p.state === "MERGED");
      if (pick) parent = { number: pick.number, base: pick.baseRefName, state: pick.state };
    } catch { /* no usable answer from gh */ }
  }
  return parent || recordedBase ? { base, parent, recordedBase } : undefined;
}

/** The warning for a stacked PR, for the PR description ("markdown") or the terminal ("text"). */
export function stackMessage(s: StackInfo, style: "markdown" | "text"): string {
  const below = s.parent ? `#${s.parent.number}` : `the PR for \`${s.base}\``;
  const target = s.parent?.base ?? s.recordedBase ?? "its target";
  const text = `This targets \`${s.base}\`, which ${s.parent ? `has its own PR (${below}) into` : "was cut from"} \`${target}\`. ` +
    `Merge ${below} first. Then re-target this PR to \`${target}\` before merging it, or delete \`${s.base}\` when ${below} merges (GitHub then re-targets this PR itself). ` +
    `Merged into \`${s.base}\` after ${below} has merged, this change would never reach \`${target}\`.`;
  return style === "markdown" ? `> **Stacked PR.** ${text}` : `Stacked PR: ${text}`;
}

/** Shorten text to at most `max` characters, at a word boundary, marking the cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[\s,;:(]+$/, "") + "…";
}

/** Per-unit mutation result from the gates of its passing attempt. */
export function mutationResults(state: TicketState, plan: Plan): { unit: string; killed: number; total: number }[] {
  const out: { unit: string; killed: number; total: number }[] = [];
  for (const u of plan.units) {
    const g = state.units[u.id]?.gates?.find((x) => x.name === "mutation");
    if (!g) continue;
    const m = g.output.match(/^(\d+) of (\d+) mutants killed/);
    out.push(m ? { unit: u.id, killed: Number(m[1]), total: Number(m[2]) } : { unit: u.id, killed: 0, total: 0 });
  }
  return out;
}

/** One line per failed attempt: unit, attempt, failed gates, first line of detail. */
export function attemptLines(state: TicketState, plan: Plan): string[] {
  const out: string[] = [];
  for (const u of plan.units) {
    const st = state.units[u.id];
    // Numbered by position: a reset unit's later builds restart their own counter (RT-2 showed 1, 2, 3 four times).
    for (const [i, h] of (st?.history ?? []).entries()) {
      const failed = [...h.report.matchAll(/^\[FAIL\] ([\w-]+)$/gm)].map((m) => m[1]);
      const lines = h.report.split("\n");
      const first = lines.find((l, i) => i > 0 && /^\[FAIL\]/.test(lines[i - 1]) && l.trim()) ?? lines[0];
      const sentence = clip(first.trim().split(/(?<=\.)\s/)[0], 160);
      const where = lines.find((l) => /^\s+\S+:\d+( \[[\w:-]+\])?$/.test(l))?.trim();
      out.push(`\`${u.id}\` attempt ${i + 1} failed ${failed.length ? failed.join(", ") : "QA"}: ${sentence}${where ? ` (${where})` : ""}`);
    }
    if (st?.status === "passed" && st.finishedBy === "developer") out.push(`\`${u.id}\` finished by a developer after ${st.history.length} failed attempt(s); the same gates passed on their change.`);
    else if (st?.history.length && st.status === "passed") out.push(`\`${u.id}\` passed on attempt ${st.history.length + 1}.`);
  }
  return out;
}

/** Repo scripts (per the active profiles) that exist but no configured check runs, or that are checked only partly. */
export function ungatedScripts(cfg: Config, scripts: Record<string, string>, profiles: Profile[] = [loadProfile("node")]): { script: string; partial?: string }[] {
  const cmds = [...cfg.checks.fast, ...cfg.checks.full, ...cfg.checks.integration, ...cfg.checks.contract];
  const runs = (s: string) => cmds.some((c) => profiles.some((p) => scriptRuns(p, s, c)));
  // A monorepo's root scripts cover every package; the workflow runs their per-package equivalents instead.
  const perPackage = [...(cfg.monorepo?.checks?.fast ?? []), ...(cfg.monorepo?.checks?.full ?? [])];
  const PER_PACKAGE: Record<string, RegExp> = { test: /\btest\b|vitest|jest/, build: /\bbuild\b|tsup/, lint: /biome|eslint|\blint\b/, typecheck: /\btsc\b|typecheck/ };
  const coveredPerPackage = (s: string) => Boolean(PER_PACKAGE[s]) && perPackage.some((c) => PER_PACKAGE[s].test(c));
  const known = [...new Set(profiles.flatMap((p) => p.scripts?.known ?? []))];
  return known.filter((s) => s in scripts && !runs(s)).map((s) =>
    coveredPerPackage(s) ? { script: s, partial: "run per package, for the packages this ticket touches, not across the whole repo" }
    : s === "lint" && cfg.checks.lintChanged ? { script: s, partial: "only new errors in files a unit changed are checked, not the whole repo" } : { script: s });
}

function ticketCost(root: string, cfg: Config, ticket: string): number | undefined {
  const file = telemetryFile(root, cfg.telemetry.file);
  if (!existsSync(file)) return undefined;
  let sum = 0;
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (e.event === "run" && e.ticket === ticket) sum += Number(e.cost_usd ?? 0); } catch { /* skip */ }
  }
  return sum;
}

export function scoreSection(root: string, ticket: string): string {
  const dir = join(root, ".ai-sdlc", "reports", ticket);
  if (existsSync(join(dir, "score.json"))) return scoreMarkdown(JSON.parse(readFileSync(join(dir, "score.json"), "utf8")) as ScoreResult);
  if (existsSync(join(dir, "score-observed.json"))) {
    const obs = JSON.parse(readFileSync(join(dir, "score-observed.json"), "utf8")).observations as { reached: boolean }[];
    return scoreMarkdown(undefined, { probes: obs.length, unreached: obs.filter((x) => !x.reached).length });
  }
  return scoreMarkdown(undefined);
}

/** Replace the score block in an existing PR body. */
export function replaceScore(body: string, score: string): string {
  const re = new RegExp(`${PR_SCORE_START}[\\s\\S]*?${PR_SCORE_END}`);
  return re.test(body) ? body.replace(re, `${PR_SCORE_START}\n${score}\n${PR_SCORE_END}`) : `${PR_SCORE_START}\n${score}\n${PR_SCORE_END}\n\n${body}`;
}

export function openPr(o: { root: string; ticket: string; cfg: Config; base?: string; dryRun?: boolean; gh?: Gh }): { url?: string; body: string; base: string; stack?: StackInfo } {
  const { root, ticket, cfg } = o;
  const ir = loadIr(root, ticket);
  const plan = loadPlan(root, ticket);
  const state = loadState(root, plan);
  const notPassed = plan.units.filter((u) => state.units[u.id].status !== "passed");
  if (notPassed.length) throw new Error(`Not ready for a PR; these units have not passed (walk = QA): ${notPassed.map((u) => `${u.id}:${state.units[u.id].status}`).join(", ")}`);
  const owed = loadOwed(join(root, "owed.yaml"));
  const openOwed = plan.units.reduce((n, u) => n + openFrom(owed, u.id).length, 0);
  if (openOwed) throw new Error(`${openOwed} owed.yaml entries are still open.`);
  const qaPath = join(root, ".ai-sdlc", "reports", ticket, "qa.md");
  const qaSummary = existsSync(qaPath) ? `QA passed. Full report attached as a PR comment (from \`.ai-sdlc/reports/${ticket}/qa.md\`).` : "QA report missing.";
  const branch = ticketBranch(cfg.branchPrefix, ticket);
  const base = o.base ?? baseBranchOf(root, branch);
  const gh = ghFor(root, cfg, o.gh);
  const stack = stackInfo(root, base, gh);
  if (stack?.parent?.state === "MERGED") {
    throw new Error(`\`${base}\` was already merged into \`${stack.parent.base}\` by #${stack.parent.number}. A PR into it now would never reach \`${stack.parent.base}\`. Target it directly: pr ${ticket} --base ${stack.parent.base}`);
  }
  const score = scoreSection(root, ticket);
  const scoreDone = existsSync(join(root, ".ai-sdlc", "reports", ticket, "score.json"));
  const hasApp = (cfg.services ?? []).some((s) => s.name === "app" && (s.start || s.url));
  const profiles = profilesFor(root, cfg);
  const scripts = readScripts(root, profiles);
  const wf = workflowRel(root);
  const changed = git(root, `diff --name-only '${base}'...HEAD`).stdout.split("\n").filter(Boolean);
  const notesPath = join(root, ".ai-sdlc", "reports", ticket, "notes.md");
  const workflowFiles = wf === "." ? 0 : changed.filter((f) => f.startsWith(`${wf}/`) || f.startsWith(".claude/") || f.startsWith(".github/workflows/")).length;
  const facts: PrFacts = {
    base,
    gatesRun: ["SCOPE", "tests changed", ...ticketChecks(root, cfg, plan).map((c) => `\`${c}\``), ...(cfg.checks.lintChanged ? ["no new lint errors"] : []), "every test seen red", `mutation (up to ${cfg.mutation.fastSubset} mutants per unit; results below)`],
    mutation: mutationResults(state, plan),
    external: plan.units.flatMap((u) => {
      const g = state.units[u.id]?.gates?.find((x) => x.name === "mutation-external");
      return g && !g.output.startsWith("no new entries") ? [{ unit: u.id, summary: g.output.split("\n")[0] }] : [];
    }),
    pins: plan.units.map((u) => ({ unit: u.id, count: Number(state.units[u.id]?.gates?.find((g) => g.name === "seen-red")?.output.match(/(\d+) pins pass/)?.[1] ?? 0) })),
    decisions: ir.questions.filter((q) => q.answer).map((q) => ({ q: q.q, answer: q.answer! })),
    notes: existsSync(notesPath) ? readFileSync(notesPath, "utf8") : undefined,
    installParts: [
      ...(changed.some((f) => f.startsWith(`${wf}/`)) ? [`${wf}/`] : []),
      ...(changed.some((f) => f.startsWith(".claude/")) ? [".claude/"] : []),
      ...(changed.some((f) => f.startsWith(".github/workflows/")) ? ["CI workflows"] : []),
    ],
    notGated: ungatedScripts(cfg, scripts, profiles),
    scoreDone,
    scoreReason: scoreDone ? undefined : hasApp ? `not run yet: ${cliHint(`score-probe ${ticket}`, root)}` : "no app configured in services, so nothing to observe",
    attempts: attemptLines(state, plan),
    costUsd: ticketCost(root, cfg, ticket),
    workflowFiles,
    stack,
  };
  const body = prBody({
    ir, plan, openOwed, qaSummary, score, facts,
    unitLines: plan.units.map((u) => `${u.id.padEnd(40)} ${state.units[u.id].status}  runs=${state.units[u.id].runs} failures=${state.units[u.id].failures}`),
  });
  const bodyFile = join(root, ".ai-sdlc", "reports", ticket, "pr-body.md");
  writeFileEnsured(bodyFile, body);
  if (o.dryRun) return { body, base, stack };
  const remote = cfg.pr?.remote || "origin";
  const push = git(root, `push -u '${remote}' '${branch}'`);
  if (push.code !== 0) throw new Error(`git push to ${remote} failed:\n${push.stderr}`);
  const existing = gh(`pr view '${branch}' --json url -q .url`);
  let url: string;
  if (existing.code === 0 && existing.stdout.trim()) {
    url = existing.stdout.trim();
    gh(`pr edit '${branch}' --body-file '${bodyFile}'`);
  } else {
    const r = gh(`pr create --base '${base}' --head '${branch}' --title '${`${ticket}: ${ir.title}`.replace(/'/g, "")}' --body-file '${bodyFile}'`);
    if (r.code !== 0) throw new Error(`gh pr create failed:\n${r.stderr ?? r.stdout}`);
    url = r.stdout.trim().split("\n").pop()!;
  }
  if (existsSync(qaPath)) gh(`pr comment '${branch}' --body-file '${qaPath}'`);
  // Recorded so later steps (paperclip-run) know the PR exists without asking GitHub.
  writeFileEnsured(join(root, ".ai-sdlc", "reports", ticket, "pr.json"), JSON.stringify({ url, base }, null, 2) + "\n");
  return { url, body, base, stack };
}

/** After score:finalize, put the score in the PR description. */
export function updatePrScore(root: string, ticket: string, cfg: Config): boolean {
  const branch = ticketBranch(cfg.branchPrefix, ticket);
  const gh = ghFor(root, cfg);
  const view = gh(`pr view '${branch}' --json body -q .body`);
  if (view.code !== 0) return false;
  const bodyFile = join(root, ".ai-sdlc", "reports", ticket, "pr-body.md");
  writeFileEnsured(bodyFile, replaceScore(view.stdout, scoreSection(root, ticket)));
  return gh(`pr edit '${branch}' --body-file '${bodyFile}'`).code === 0;
}
