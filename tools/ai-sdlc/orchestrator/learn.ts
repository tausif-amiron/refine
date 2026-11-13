// Learning loop, simplest form: corrections a person repeats become CONVENTIONS.md lines.
// Finds human review comments on recently merged PRs, keeps those where the review agent said nothing
// near the same line (a miss), clusters similar ones across PRs, and proposes convention lines.
// Deterministic; a person decides which proposals to keep.
import { join } from "node:path";
import { sh, writeFileEnsured } from "./util.ts";

export interface ReviewComment { pr: number; path: string; line: number | null; body: string; bot: boolean }

const STOP = new Set("the a an and or to of in on for is are be this that it with as at by we you should please use not do don't can could would from".split(" "));

export function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/```[\s\S]*?```/g, " ").replace(/[^a-z0-9_ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/** Human comments with no bot comment within ±3 lines of the same file in the same PR. */
export function misses(comments: ReviewComment[]): ReviewComment[] {
  return comments.filter((c) => !c.bot && !comments.some((b) => b.bot && b.pr === c.pr && b.path === c.path && c.line !== null && b.line !== null && Math.abs(b.line - c.line) <= 3));
}

/** Greedy clustering; a cluster counts when it spans at least `minPrs` distinct PRs. */
export function clusters(cs: ReviewComment[], threshold = 0.34, minPrs = 2): ReviewComment[][] {
  const groups: { rep: Set<string>; items: ReviewComment[] }[] = [];
  for (const c of cs) {
    const t = tokens(c.body);
    if (t.size < 2) continue;
    const g = groups.find((x) => jaccard(x.rep, t) >= threshold);
    if (g) g.items.push(c); else groups.push({ rep: t, items: [c] });
  }
  return groups.map((g) => g.items).filter((items) => new Set(items.map((i) => i.pr)).size >= minPrs).sort((a, b) => b.length - a.length);
}

export function fetchComments(root: string, days: number): ReviewComment[] {
  const repo = sh(`gh repo view --json nameWithOwner -q .nameWithOwner`, { cwd: root }).stdout.trim();
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const prs = JSON.parse(sh(`gh pr list --state merged --search 'merged:>=${since}' --limit 100 --json number`, { cwd: root }).stdout || "[]") as { number: number }[];
  const out: ReviewComment[] = [];
  for (const { number } of prs) {
    const raw = JSON.parse(sh(`gh api --paginate repos/${repo}/pulls/${number}/comments`, { cwd: root }).stdout || "[]") as any[];
    for (const c of raw) out.push({ pr: number, path: c.path, line: c.line ?? c.original_line ?? null, body: c.body ?? "", bot: c.user?.type === "Bot" || /\[bot\]$/.test(c.user?.login ?? "") });
  }
  return out;
}

export function proposalsMarkdown(groups: ReviewComment[][]): string {
  if (!groups.length) return "# Convention proposals\n\nNo repeated corrections found.\n";
  return [
    "# Convention proposals",
    "",
    "Corrections reviewers made more than once that the review agent did not catch. For each, write one line in",
    "docs/CONVENTIONS.md (or reject it), commit, and the next agents will read it. Decisions with lasting impact become an ADR.",
    "",
    ...groups.flatMap((g, i) => [
      `## ${i + 1}. Seen in ${new Set(g.map((c) => c.pr)).size} PRs (${g.length} comments)`,
      ...g.slice(0, 5).map((c) => `- PR #${c.pr} \`${c.path}${c.line ? `:${c.line}` : ""}\`: ${c.body.split("\n")[0].slice(0, 200)}`),
      `- Proposed line: _<write the rule in one sentence>_`,
      "",
    ]),
  ].join("\n");
}

export function learn(root: string, days = 30): string {
  const md = proposalsMarkdown(clusters(misses(fetchComments(root, days))));
  const path = join(root, ".ai-sdlc", "learn", "proposals.md");
  writeFileEnsured(path, md);
  return path;
}
