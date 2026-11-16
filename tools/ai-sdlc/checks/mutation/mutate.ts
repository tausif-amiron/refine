// Mutation engine. Generic operators apply to changed lines; catalogue entries apply anywhere
// their file glob matches. Order is deterministic so the "fast subset" is reproducible.
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import picomatch from "picomatch";
import { profileForFile } from "../hooks/profile.mjs";

export interface Mutant {
  id: string;
  file: string;
  line: number;          // 1-based
  original: string;      // the original line
  mutated: string;       // the replacement line
  operator: string;
}

interface Operator { name: string; re: RegExp; replace: string }

// Each operator rewrites the first match on a line. Kept small and meaningful.
// One set per language family; a profile names its set (profiles/<name>.json → mutation.operators).
export const JS_OPERATORS: Operator[] = [
  { name: "strict-eq-flip", re: /===/, replace: "!==" },
  { name: "strict-neq-flip", re: /!==/, replace: "===" },
  { name: "gte-to-gt", re: />=/, replace: ">" },
  { name: "lte-to-lt", re: /<=/, replace: "<" },
  { name: "gt-to-gte", re: /(?<![=>-])>(?![=>])/, replace: ">=" },
  { name: "lt-to-lte", re: /(?<![<=])<(?![=<])/, replace: "<=" },
  { name: "and-to-or", re: /&&/, replace: "||" },
  { name: "or-to-and", re: /\|\|/, replace: "&&" },
  { name: "true-to-false", re: /\btrue\b/, replace: "false" },
  { name: "false-to-true", re: /\bfalse\b/, replace: "true" },
  { name: "plus-to-minus", re: /(?<![+])\+(?![+=])/, replace: "-" },
  { name: "return-undefined", re: /\breturn\s+(?!;)([^;]+);/, replace: "return undefined;" },
  { name: "floor-to-round", re: /Math\.floor\(/, replace: "Math.round(" },
  { name: "floor-to-ceil", re: /Math\.floor\(/, replace: "Math.ceil(" },
  { name: "round-to-floor", re: /Math\.round\(/, replace: "Math.floor(" },
  { name: "ceil-to-floor", re: /Math\.ceil\(/, replace: "Math.floor(" },
  { name: "drop-await-call", re: /^(\s*)await\s+([^;]+);\s*$/, replace: "$1/* mutated: removed */;" },
];

interface OperatorSet {
  operators: Operator[];
  /** Second tier, used only when no first-tier operator applies to a unit's changes (declarative code). */
  literals: Operator[];
  skipLine: RegExp;
  stringOnlyLine: RegExp;
}

// A string literal (single or double quotes, escapes allowed).
const JS_STRING = String.raw`(["'])(?:(?!\1)[^\\]|\\.)+\1`;

export const JS_LITERALS: Operator[] = [
  { name: "template-drop-expr", re: /\$\{[^}]+\}/, replace: "" },
  { name: "prop-value-empty", re: /(\b\w+\s*:\s*)(["'`])(?:(?!\2).)*\2/, replace: '$1""' },
  { name: "string-empty", re: new RegExp(JS_STRING), replace: '""' },
];

export const PYTHON_LITERALS: Operator[] = [
  { name: "fstring-drop-expr", re: /(\bf["'][^"'{]*)\{[^}]+\}/, replace: "$1" },
  { name: "kwarg-value-empty", re: /(\b\w+=)(["'])(?:(?!\2).)*\2/, replace: '$1""' },
  { name: "string-empty", re: new RegExp(String.raw`(?<![\w])` + JS_STRING), replace: '""' },
];

export const PYTHON_OPERATORS: Operator[] = [
  { name: "eq-flip", re: /==/, replace: "!=" },
  { name: "neq-flip", re: /!=/, replace: "==" },
  { name: "gte-to-gt", re: />=/, replace: ">" },
  { name: "lte-to-lt", re: /<=/, replace: "<" },
  { name: "gt-to-gte", re: /(?<![=>-])>(?![=>])/, replace: ">=" },
  { name: "lt-to-lte", re: /(?<![<=])<(?![=<])/, replace: "<=" },
  { name: "and-to-or", re: /\band\b/, replace: "or" },
  { name: "or-to-and", re: /\bor\b/, replace: "and" },
  { name: "drop-not", re: /\bnot\s+/, replace: "" },
  { name: "true-to-false", re: /\bTrue\b/, replace: "False" },
  { name: "false-to-true", re: /\bFalse\b/, replace: "True" },
  { name: "plus-to-minus", re: /(?<![+*])\+(?![+=])/, replace: "-" },
  { name: "floordiv-to-div", re: /\/\//, replace: "/" },
  { name: "return-none", re: /\breturn\s+(?!None\b)\S.*$/, replace: "return None" },
  { name: "floor-to-round", re: /\bmath\.floor\(/, replace: "round(" },
  { name: "floor-to-ceil", re: /\bmath\.floor\(/, replace: "math.ceil(" },
  { name: "ceil-to-floor", re: /\bmath\.ceil\(/, replace: "math.floor(" },
];

export const OPERATOR_SETS: Record<string, OperatorSet> = {
  js: {
    operators: JS_OPERATORS,
    literals: JS_LITERALS,
    skipLine: /^\s*(\/\/|\*|\/\*|import\s|export\s+(type|interface)\s|type\s|interface\s)/,
    stringOnlyLine: /^\s*["'`].*["'`],?\s*$/,
  },
  python: {
    operators: PYTHON_OPERATORS,
    literals: PYTHON_LITERALS,
    // comments, imports, decorators, signatures, docstring lines
    skipLine: /^\s*(#|import\s|from\s+\S+\s+import\s|@|def\s|async\s+def\s|class\s|"""|\'\'\')/,
    stringOnlyLine: /^\s*[rbuf]*["'].*["'],?\s*$/i,
  },
};

/** The operator set for a file, from the profile that owns its extension (none: the file is not mutated). */
export function operatorSetFor(file: string): OperatorSet | undefined {
  const p = profileForFile(file);
  return p ? OPERATOR_SETS[p.mutation.operators] : undefined;
}

/**
 * Literal mutants (second tier) for the given lines of a file: emptied strings, dropped template/f-string
 * expressions, emptied keyword or property values. Used only when no first-tier mutant applies to a unit's change,
 * so declarative code (a flag, a route, a config value) is still tested by mutation. Lines that are only a string
 * are not skipped here: they are what this tier is for. Docstrings and skip-marked lines still are.
 */
export function literalMutants(file: string, content: string, lines: number[]): Mutant[] {
  const set = operatorSetFor(file);
  if (!set) return [];
  return mutate(file, content, lines, set.literals, set.skipLine);
}

/** Generic mutants for the given lines of a file. */
export function genericMutants(file: string, content: string, lines: number[]): Mutant[] {
  const set = operatorSetFor(file);
  if (!set) return [];
  return mutate(file, content, lines, set.operators, set.skipLine, set.stringOnlyLine);
}

function mutate(file: string, content: string, lines: number[], operators: Operator[], skipLine: RegExp, stringOnlyLine?: RegExp): Mutant[] {
  const src = content.split("\n");
  const out: Mutant[] = [];
  for (const ln of [...new Set(lines)].sort((a, b) => a - b)) {
    const original = src[ln - 1];
    if (original === undefined || skipLine.test(original) || original.includes("ai-sdlc-mutation: skip")) continue;
    // First tier: do not mutate inside string literals in a crude way; skip lines that are only a string.
    if (stringOnlyLine?.test(original)) continue;
    for (const op of operators) {
      if (!op.re.test(original)) continue;
      const mutated = original.replace(op.re, op.replace);
      // Two operators can produce the same line; one test run per distinct mutation.
      if (out.some((m) => m.line === ln && m.mutated === mutated)) continue;
      if (mutated !== original) out.push({ id: `${file}:${ln}:${op.name}`, file, line: ln, original, mutated, operator: op.name });
    }
  }
  return out;
}

export interface CatalogueEntry { id: string; file: string; find: string; replace: string; regex?: boolean; note?: string }

export function loadCatalogue(path: string): CatalogueEntry[] {
  if (!existsSync(path)) return [];
  const raw = parse(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? (raw as CatalogueEntry[]) : [];
}

/** Catalogue mutants for a set of files: each entry applies to every line it matches. */
export function catalogueMutants(entries: CatalogueEntry[], files: { path: string; content: string }[]): Mutant[] {
  const out: Mutant[] = [];
  for (const e of entries) {
    const match = picomatch(e.file, { dot: true });
    for (const f of files) {
      if (!match(f.path)) continue;
      f.content.split("\n").forEach((line, i) => {
        const re = e.regex ? new RegExp(e.find) : null;
        const hit = re ? re.test(line) : line.includes(e.find);
        if (!hit) return;
        const mutated = re ? line.replace(re, e.replace) : line.replace(e.find, e.replace);
        if (mutated !== line) out.push({ id: `catalogue:${e.id}:${f.path}:${i + 1}`, file: f.path, line: i + 1, original: line, mutated, operator: `catalogue:${e.id}` });
      });
    }
  }
  return out;
}

/** Deterministic spread: interleave files so a small subset covers many files, then take `n`. */
export function subset(mutants: Mutant[], n: number): Mutant[] {
  const byFile = new Map<string, Mutant[]>();
  for (const m of [...mutants].sort((a, b) => a.id.localeCompare(b.id))) (byFile.get(m.file) ?? byFile.set(m.file, []).get(m.file)!).push(m);
  const queues = [...byFile.keys()].sort().map((k) => byFile.get(k)!);
  const out: Mutant[] = [];
  while (out.length < n && queues.some((q) => q.length)) for (const q of queues) if (q.length && out.length < n) out.push(q.shift()!);
  return out;
}

export function applyMutant(content: string, m: Mutant): string {
  const lines = content.split("\n");
  if (lines[m.line - 1] !== m.original) throw new Error(`mutant ${m.id} does not match file content`);
  lines[m.line - 1] = m.mutated;
  return lines.join("\n");
}

/** Line numbers added or changed in `file` according to a unified diff with zero context. */
export function changedLinesFromDiff(diffText: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let file: string | null = null;
  let line = 0;
  for (const l of diffText.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); if (file === "/dev/null") file = null; continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) { line = Number(h[1]); continue; }
    if (!file) continue;
    if (l.startsWith("+") && !l.startsWith("+++")) { (out.get(file) ?? out.set(file, []).get(file)!).push(line); line++; }
    else if (!l.startsWith("-")) line++;
  }
  return out;
}
