#!/usr/bin/env -S npx tsx
// Entry point: npm run <stage> -- <args>. See README.md for the full flow.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { doctor, formatFindings } from "./doctor.ts";
import { withGateway } from "./gateway.ts";
import { cliStepRunner, HttpPaperclip, paperclipRun, paperclipSync } from "./paperclip.ts";
import { cliHint, loadConfig, repoRoot } from "./config.ts";
import { extractTicket } from "./extract.ts";
import { commitAll, ensureBranch, ticketBranch, headCommit } from "./git.ts";
import { loadIr, validateIr } from "./ir.ts";
import { Jira } from "./jira.ts";
import { answersComment, moveTicket, postOnce, prComment } from "./jira-sync.ts";
import { learn } from "./learn.ts";
import { defaultStore, handleAlert, normaliseAlerts, verifyFixes } from "./ops.ts";
import { buildPlan, verifyPlan } from "./plan.ts";
import { openPr, stackMessage, updatePrScore } from "./pr.ts";
import { qaTicket } from "./qa.ts";
import { releaseNotes, stagedDeploy, watchAfterDeploy } from "./release.ts";
import { reviewPr } from "./review.ts";
import { buildTicket, planPath } from "./run.ts";
import { defaultRunner } from "./runner.ts";
import { compareScores, finalizeScore, runScoreProbe, scoreMarkdown } from "./score.ts";
import { withServices } from "./services.ts";
import { stableStringify, writeFileEnsured } from "./util.ts";

function args(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const out = (s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = args(rest);
  const root = repoRoot();
  const cfg = loadConfig(root);
  const runner = withGateway(defaultRunner(), cfg);
  const ticket = pos[0];
  const needTicket = () => { if (!ticket || !/^[A-Z][A-Z0-9]+-\d+$/.test(ticket)) throw new Error(`usage: ${cliHint(`${cmd} <TICKET>`, root)}`); return ticket; };

  switch (cmd) {
    case "paperclip-run": {
      // Inside a Paperclip "process" agent run: Paperclip supplies these.
      const e = process.env;
      if (!e.PAPERCLIP_API_URL || !e.PAPERCLIP_RUN_ID || !e.PAPERCLIP_AGENT_ID || !e.PAPERCLIP_COMPANY_ID) throw new Error("paperclip-run runs inside a Paperclip process agent (PAPERCLIP_API_URL, PAPERCLIP_RUN_ID, PAPERCLIP_AGENT_ID and PAPERCLIP_COMPANY_ID are not set). See docs/ARCHITECTURE.md#paperclip.");
      const api = new HttpPaperclip(e.PAPERCLIP_API_URL, e.PAPERCLIP_API_KEY, e.PAPERCLIP_RUN_ID);
      out(await paperclipRun({ root, api, runStep: cliStepRunner(root), runId: e.PAPERCLIP_RUN_ID, agentId: e.PAPERCLIP_AGENT_ID, companyId: e.PAPERCLIP_COMPANY_ID }));
      return;
    }
    case "paperclip-sync": {
      const pc = cfg.paperclip;
      const project = (flags.project as string | undefined) ?? pc?.project;
      if (!pc?.url || !pc.companyId || !pc.agentId || !project) throw new Error("paperclip-sync needs paperclip.url, paperclip.companyId, paperclip.agentId (PAPERCLIP_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_RUNNER_AGENT_ID) and a Jira project (--project or JIRA_PROJECT).");
      const jira = Jira.fromEnv();
      if (!jira) throw new Error("paperclip-sync reads Jira: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.");
      const r = await paperclipSync({ api: new HttpPaperclip(pc.url, process.env.PAPERCLIP_BOARD_KEY), jira, project, readyStatus: cfg.jira.readyStatus, companyId: pc.companyId, agentId: pc.agentId, jiraUrl: process.env.JIRA_BASE_URL?.replace(/\/$/, ""), dryRun: Boolean(flags["dry-run"]) });
      out(`${flags["dry-run"] ? "Would create" : "Created"}: ${r.created.join(", ") || "none"}\nAlready in Paperclip: ${r.existing.join(", ") || "none"}`);
      return;
    }
    case "doctor": {
      const run = (c: string, a: string[], cwd?: string, env?: Record<string, string>) => {
        const r = spawnSync(c, a, { cwd: cwd ?? root, encoding: "utf8", env: { ...process.env, ...env } });
        return { code: r.status ?? 127, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      };
      const findings = await doctor(root, cfg, { run, fetch, env: process.env }, { preflight: Boolean(flags.preflight), project: typeof flags.project === "string" ? flags.project : undefined });
      out(formatFindings(findings));
      if (!flags.preflight) out(`\nAdd --preflight to also run the full checks at the current commit (slow).`);
      if (findings.some((f) => f.level === "fail")) process.exitCode = 1;
      return;
    }
    case "extract": {
      const r = await extractTicket({ root, ticket: needTicket(), cfg, runner, ticketFile: flags["ticket-file"] as string | undefined, force: Boolean(flags.force) });
      if (r.issues.length) { out(`IR rejected:\n${r.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`); process.exitCode = 2; return; }
      out(`IR written: ${r.path}`);
      if (r.needsAnswers) { out(`Clarification needed: ${r.ir!.questions.filter((q) => !q.answer).length} question(s), ${r.ir!.unplaced.length} unplaced. Answer in the IR (questions[].answer), then run: ${cliHint(`plan ${ticket}`, root)}`); process.exitCode = 3; }
      return;
    }
    case "plan": {
      const t = needTicket();
      ensureBranch(root, ticketBranch(cfg.branchPrefix, t));
      const ir = loadIr(root, t);
      const irIssues = validateIr(ir);
      if (irIssues.length) throw new Error(`IR invalid:\n${irIssues.map((i) => `${i.path}: ${i.message}`).join("\n")}`);
      const plan = buildPlan(ir, cfg);
      const issues = verifyPlan(ir, plan);
      if (issues.length) throw new Error(`Plan failed its checks:\n${issues.map((i) => i.message).join("\n")}`);
      writeFileEnsured(planPath(root, t), stableStringify(plan));
      for (const c of plan.contracts) writeFileEnsured(join(root, c.path), c.content);
      commitAll(root, `docs(plan): units and contracts for ${t}\n\nTicket: ${t}`);
      out(`${plan.units.length} units, ${plan.contracts.length} contracts:\n${plan.units.map((u) => `  ${u.id}  ← ${u.dependsOn.join(", ") || "-"}`).join("\n")}`);
      const posted = await postOnce(root, t, "answers", answersComment(ir, plan), Jira.fromEnv()).catch((e) => `failed: ${String(e)}`);
      if (posted !== "skipped: ticket not from Jira") out(`Jira: answers and plan ${posted}`);
      const moved = await moveTicket(root, t, "answered", cfg, Jira.fromEnv()).catch((e) => `failed: ${String(e)}`);
      if (moved.startsWith("moved") || moved.startsWith("failed")) out(`Jira: ticket ${moved}`);
      return;
    }
    case "run": {
      const t = needTicket();
      ensureBranch(root, ticketBranch(cfg.branchPrefix, t));
      const b = await buildTicket({ root, ticket: t, cfg, runner });
      out(b.summary);
      if (b.status !== "pass") { process.exitCode = 4; return; }
      if (flags["no-qa"]) return;
      const q = await qaTicket({ root, ticket: t, cfg, runner });
      out(`${q.summary}\nQA report: ${q.reportPath}`);
      if (q.status !== "pass") process.exitCode = 5;
      return;
    }
    case "gates": {
      // A developer finished an escalated unit on its branch: run the same gates on it, with no agent.
      const t = needTicket();
      const unit = pos[1];
      if (!unit) throw new Error(`usage: ${cliHint("gates <TICKET> <unit id>", root)}`);
      const b = await buildTicket({ root, ticket: t, cfg, runner, takeOver: unit });
      out(b.summary);
      if (b.status !== "pass") { process.exitCode = 4; return; }
      out(`Next: ${cliHint(`qa ${t}`, root)}`);
      return;
    }
    case "qa": {
      const q = await qaTicket({ root, ticket: needTicket(), cfg, runner });
      out(`${q.summary}\nQA report: ${q.reportPath}`);
      if (q.status !== "pass") process.exitCode = q.status === "blocked" ? 6 : 5;
      return;
    }
    case "score-probe": {
      const t = needTicket();
      const probe = (appUrl: string) => runScoreProbe({ root, ir: loadIr(root, t), cfg, runner, appUrl, buildRef: headCommit(root) });
      // --url scores a build that is already running (e.g. staging); otherwise start the configured services.
      const r = flags.url
        ? await probe(String(flags.url))
        : await withServices(root, cfg.services, join(root, ".ai-sdlc", "reports", t, "services"), async (env) => {
            if (!env.APP_URL) throw new Error("No app to score: pass --url, or configure the 'app' service (APP_START_COMMAND and APP_URL).");
            return probe(env.APP_URL);
          });
      out(`${r.observations.length} probes observed (${r.observations.filter((o) => !o.reached).length} unreached).\nA person now judges: ${r.judgingPath}\nThen: ${cliHint(`score-finalize ${t}`, root)}`);
      return;
    }
    case "score-finalize": {
      const t = needTicket();
      const s = finalizeScore(root, loadIr(root, t));
      out(scoreMarkdown(s));
      if (!flags["no-pr"]) out(updatePrScore(root, t, cfg) ? "PR description updated." : "No PR yet; the score will be included when the PR is opened.");
      if (flags.compare) out(compareScores(s, JSON.parse(readFileSync(String(flags.compare), "utf8"))));
      return;
    }
    case "pr": {
      const r = openPr({ root, ticket: needTicket(), cfg, base: flags.base as string | undefined, dryRun: Boolean(flags["dry-run"]) });
      if (r.stack) process.stderr.write(`⚠ ${stackMessage(r.stack, "text")}\n\n`);
      out(r.url ? `${r.url} (base: ${r.base})` : `Base branch: ${r.base}\n\n${r.body}`);
      if (r.url) {
        const posted = await postOnce(root, needTicket(), "pr", prComment(r.url, r.base), Jira.fromEnv()).catch((e) => `failed: ${String(e)}`);
        if (posted !== "skipped: ticket not from Jira") out(`Jira: pull request link ${posted}`);
        const moved = await moveTicket(root, needTicket(), "inReview", cfg, Jira.fromEnv()).catch((e) => `failed: ${String(e)}`);
        if (moved !== "skipped: ticket not from Jira") out(`Jira: ticket ${moved}`);
      }
      return;
    }
    case "review": {
      const pr = pos[0] ?? process.env.PR_NUMBER;
      if (!pr) throw new Error(`usage: ${cliHint("review <PR number>", root)}`);
      const r = await reviewPr({ root, pr, cfg, runner, post: !flags["dry-run"] });
      out(`Review ${flags["dry-run"] ? "(dry run)" : "posted"}: event=${r.payload.event}, ${r.payload.comments.length} line comments`);
      return;
    }
    case "release": {
      const sub = pos[0];
      const version = (flags.version as string) ?? process.env.RELEASE_VERSION ?? headCommit(root).slice(0, 12);
      if (sub === "notes") out(await releaseNotes({ root, cfg, runner, from: (flags.from as string) ?? "", version }));
      else if (sub === "deploy") { const r = await stagedDeploy({ root, cfg, version }); out(r.log.join("\n")); if (!r.ok) process.exitCode = 6; }
      else if (sub === "watch") { const r = await watchAfterDeploy({ root, cfg, version, minutes: flags.minutes ? Number(flags.minutes) : undefined }); out(r.ok ? "watch window clean" : `rolled back: ${r.reason}`); if (!r.ok) process.exitCode = 7; }
      else if (sub === "fix-deployed") {
        const store = defaultStore(root, cfg);
        for (const key of pos.slice(1)) await store.setStatus(key, "fix-deployed", `Fix deployed in ${version}. Verification window: ${cfg.ops.verifyWindowMinutes} minutes.`);
        out(`marked fix-deployed: ${pos.slice(1).join(", ") || "(none)"}`);
      }
      else if (sub === "done") {
        // Tickets named in this release's "Ticket:" commit footers. Only this repo's project moves: a footer is
        // text in a commit, and a key from another project is left alone.
        const jira = Jira.fromEnv();
        const keys = [...new Set(pos.slice(1))].filter((k) => new RegExp(`^${cfg.ticketPrefix}-\\d+$`).test(k));
        for (const key of keys) out(`${key}: ${await moveTicket(root, key, "released", cfg, jira).catch((e) => `failed: ${String(e)}`)}`);
        if (!keys.length) out(`no ${cfg.ticketPrefix} tickets in this release`);
      }
      else throw new Error(`usage: ${cliHint("release notes|deploy|watch|fix-deployed|done [--version v] [--from ref]", root)}`);
      return;
    }
    case "ops-alert": {
      const file = pos[0] ?? process.env.ALERT_FILE;
      const payload = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : JSON.parse(process.env.ALERT_PAYLOAD ?? "null");
      for (const alert of normaliseAlerts(payload)) out(JSON.stringify(await handleAlert({ root, cfg, runner, alert })));
      return;
    }
    case "ops-verify": {
      out(JSON.stringify(await verifyFixes({ root, cfg })));
      return;
    }
    case "learn": {
      out(`Proposals: ${learn(root, flags.days ? Number(flags.days) : 30, cfg.pr?.repo)}`);
      return;
    }
    default:
      out("commands: doctor | gates | paperclip-sync | paperclip-run | extract | plan | run | qa | score-probe | score-finalize | pr | review | release | ops-alert | ops-verify | learn");
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
