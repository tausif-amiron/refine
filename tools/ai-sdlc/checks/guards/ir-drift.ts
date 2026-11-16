// CI gate: the IR on the branch must still match the ticket it was extracted from. If someone edited the
// ticket after extraction, the hash differs and the build must be re-extracted (the bar was sealed).
// Usage: tsx checks/guards/ir-drift.ts [TICKET...]   (defaults to every ir/*.ir.json)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Jira } from "../../orchestrator/jira.ts";
import { sha256 } from "../../orchestrator/util.ts";
import type { IR } from "../../orchestrator/types.ts";

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const irDir = join(root, "ir");
const tickets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : existsSync(irDir) ? readdirSync(irDir).filter((f) => f.endsWith(".ir.json")).map((f) => f.replace(".ir.json", "")) : [];

const jira = Jira.fromEnv();
if (!jira) { console.log("ir-drift: Jira credentials not set; skipped (set JIRA_* secrets to enforce)."); process.exit(0); }

let failed = 0;
for (const t of tickets) {
  const ir = JSON.parse(readFileSync(join(irDir, `${t}.ir.json`), "utf8")) as IR;
  const issue = await jira.getIssue(t);
  const now = sha256(`# ${issue.summary}\n\n${issue.text}`);
  if (now !== ir.ticket_hash) { failed++; console.error(`${t}: ticket changed after extraction (IR ${ir.ticket_hash.slice(0, 19)} ≠ ticket ${now.slice(0, 19)}). Re-extract: npm run extract -- ${t}`); }
  else console.log(`${t}: IR matches ticket`);
}
process.exit(failed ? 1 : 0);
