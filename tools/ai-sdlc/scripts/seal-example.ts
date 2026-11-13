// Re-seal the example IR from its ticket after editing ir/examples/JIRA-123.draft.json or the ticket.
// Usage: npx tsx scripts/seal-example.ts
import { readFileSync } from "node:fs";
import { parseAcceptanceCriteria, seal, validateIr } from "../orchestrator/ir.ts";
import { stableStringify, writeFileEnsured } from "../orchestrator/util.ts";

const text = readFileSync("ir/examples/JIRA-123.ticket.md", "utf8");
const draft = JSON.parse(readFileSync("ir/examples/JIRA-123.draft.json", "utf8"));
const ir = seal(draft, text, parseAcceptanceCriteria(text));
const issues = validateIr(ir, text);
if (issues.length) { console.error(issues); process.exit(1); }
writeFileEnsured("ir/examples/JIRA-123.ir.json", stableStringify(ir));
console.log(`sealed ${ir.sealed_acceptance_criteria.length} criteria`);
