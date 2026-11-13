#!/usr/bin/env node
// Guard: no literals that look like credentials in tracked files (or files changed since BASE_REF).
// Complements gitleaks in CI; runs locally in checks.full so agents see it before CI does.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadBrief, projectDir, sh } from "../hooks/lib.mjs";

export const PATTERNS = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["AWS access key id", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{60,}/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Private key", /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["Atlassian API token", /\bATATT[A-Za-z0-9_\-=]{30,}/],
  ["Generic assignment", /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];

const ALLOW = /ai-sdlc-secrets: allow|example|placeholder|dummy|fake|xxx|<[^>]+>/i;

export function scan(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line) && !ALLOW.test(line)) hits.push({ line: i + 1, name });
  });
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = projectDir();
  const base = process.env.BASE_REF;
  // Scan what changed: since BASE_REF (CI), since the unit's base commit (agent runs), else every tracked file.
  // An agent is answerable for what it wrote, not for what the repo already contained.
  const brief = base ? undefined : loadBrief(root);
  const list = base
    ? sh(`git diff --name-only --diff-filter=ACMR ${base}...HEAD`, root).out
    : brief?.base_commit
      ? sh(`git diff --name-only --diff-filter=ACMR ${brief.base_commit} && git ls-files --others --exclude-standard`, root).out
      : sh("git ls-files", root).out;
  const files = [...new Set(list.split("\n"))].filter((f) => f && !f.startsWith(".ai-sdlc/") && !/(^|\/)(node_modules|package-lock\.json|.*\.(png|jpg|gif|ico|pdf|woff2?|lock))$/.test(f) && !f.endsWith("checks/guards/no-secrets.mjs") && !f.startsWith("tests/"));
  const findings = [];
  for (const f of files) {
    const p = join(root, f);
    if (!existsSync(p) || statSync(p).size > 2_000_000) continue;
    for (const h of scan(readFileSync(p, "utf8"))) findings.push(`${f}:${h.line} ${h.name}`);
  }
  if (findings.length) { console.error(`Possible secrets in code:\n${findings.join("\n")}\nMove them to the environment (.env, never committed).`); process.exit(1); }
  console.log(`no-secrets: ${files.length} files clean`);
}
