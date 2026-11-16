#!/usr/bin/env node
// PreToolUse hook for Bash. Blocks commands that read secrets, dump the environment, push, rewrite
// history, or pipe downloads into a shell. Orchestrated runs additionally may not push or touch git config.
import { deny, loadBrief, readStdinJson } from "./lib.mjs";
import { forbiddenCommand, installDecision } from "./profile.mjs";

const isMain = import.meta.url === `file://${process.argv[1]}`;
const input = isMain ? await readStdinJson() : {};
const cmd = String(input.tool_input?.command ?? "");
if (isMain && !cmd) process.exit(0);

// Any token naming a .env file other than .env.example (e.g. .env, .env.local, config/.env.prod).
const envFiles = [...cmd.matchAll(/(?:^|[\s;&|<>"'`(=/])(\.env(?:\.[\w.-]+)?)(?=$|[\s;&|<>"'`)])/g)].map((m) => m[1]);
if (envFiles.some((f) => f !== ".env.example")) deny("Blocked: this command reads or writes a .env file. See CLAUDE.md rules.");

const ALWAYS = [
  [/(^|[\s/])secrets\//, "touches secrets/"],
  [/\b(printenv|env)\s*($|[|;&>])/, "dumps the environment"],
  [/\bset\s*($|[|;&>])/, "dumps shell variables"],
  [/\becho\s+[^|;&]*\$\{?[A-Z_]*(TOKEN|KEY|SECRET|PASSWORD)[A-Z_]*\}?/, "prints a credential"],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, "pipes a download into a shell"],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/, "deletes a root or home directory"],
  [/\bgit\s+push\b[^;&|]*\s(--force|-f)(\s|$)/, "force-pushes"],
];
for (const [re, why] of ALWAYS) if (re.test(cmd)) deny(`Blocked: this command ${why}. See CLAUDE.md rules.`);

// Package installs (only the foundation unit adds packages, only the IR's) and registry publishing are
// defined per ecosystem in profiles/<name>.json; see profile.mjs.
export { installDecision } from "./profile.mjs";

const brief = loadBrief();
if (brief) {
  const why = installDecision(cmd, brief);
  const forbidden = forbiddenCommand(cmd);
  if (forbidden) deny(`Blocked in agent runs: this command ${forbidden}.`);
  if (why) deny(`Blocked in agent runs: ${why}.`);
}

if (brief) {
  const AGENT = [
    [/\bgit\s+push\b/, "pushes; the orchestrator merges and pushes after gates pass"],
    [/\bgit\s+(config|remote|rebase|reset\s+--hard|checkout\s+(main|master)\b|switch\s+(main|master)\b|branch\s+-[dD])/, "changes git configuration, history or branches"],
    [/\bgh\s+(pr|api|release|repo)\b/, "uses the GitHub CLI; agents do not open, review or merge PRs"],
    [/--no-verify\b/, "skips verification"],
  ];
  for (const [re, why] of AGENT) if (re.test(cmd)) deny(`Blocked in agent runs: this command ${why}.`);
}
if (isMain) process.exit(0);
