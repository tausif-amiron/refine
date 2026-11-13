// IR: load, validate (schema + anchors + cross references), seal. All checks here are code;
// the extract agent's output is never trusted until it passes validateIr().
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { cliHint, WORKFLOW_ROOT } from "./config.ts";
import { isManifest } from "../checks/hooks/profile.mjs";
import type { AcceptanceCriterion, IR } from "./types.ts";
import { sha256, stableStringify } from "./util.ts";

const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as new (o: object) => {
  compile: (s: object) => ((d: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
};

let validator: ReturnType<InstanceType<typeof Ajv2020>["compile"]> | undefined;
function schemaValidator() {
  if (!validator) {
    const schema = JSON.parse(readFileSync(join(WORKFLOW_ROOT, "ir/schema.json"), "utf8"));
    validator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  }
  return validator;
}

export function irPath(root: string, ticket: string): string {
  return join(root, "ir", `${ticket}.ir.json`);
}

export function loadIr(root: string, ticket: string): IR {
  const p = irPath(root, ticket);
  if (!existsSync(p)) throw new Error(`IR not found: ${p}. Run: ${cliHint(`extract ${ticket}`, root)}`);
  return JSON.parse(readFileSync(p, "utf8")) as IR;
}

/** Normalise text for anchor matching: unify quotes/dashes, collapse whitespace, lowercase. */
export function normaliseText(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface IrIssue { path: string; message: string }

/**
 * Validate an IR against the schema, the ticket text (every anchor must quote the ticket),
 * and itself (every reference resolves). Returns a list of issues; empty means valid.
 */
export function validateIr(ir: unknown, ticketText?: string): IrIssue[] {
  const issues: IrIssue[] = [];
  const v = schemaValidator();
  if (!v(ir)) {
    for (const e of v.errors ?? []) issues.push({ path: e.instancePath || "/", message: e.message ?? "invalid" });
    return issues; // structural errors make the remaining checks meaningless
  }
  const doc = ir as IR;

  // Anchors quote the ticket.
  if (ticketText !== undefined) {
    const hay = normaliseText(ticketText);
    const check = (path: string, quote: string) => {
      if (!hay.includes(normaliseText(quote))) issues.push({ path, message: `anchor quote not found in ticket: "${quote.slice(0, 80)}"` });
    };
    const groups = ["entities", "roles", "screens", "services", "external_systems", "limits", "modules"] as const;
    for (const g of groups) ((doc[g] ?? []) as { anchor: { quote: string } }[]).forEach((x, i) => check(`/${g}/${i}/anchor`, x.anchor.quote));
  }

  // Seal is intact.
  if (doc.sealed_hash !== sealHash(doc.sealed_acceptance_criteria)) {
    issues.push({ path: "/sealed_hash", message: "sealed acceptance criteria were changed after extraction; re-extract the ticket" });
  }

  // Unique names.
  const dupes = (g: string, names: string[]) => {
    const seen = new Set<string>();
    for (const n of names) {
      const k = n.toLowerCase();
      if (seen.has(k)) issues.push({ path: `/${g}`, message: `duplicate name "${n}"` });
      seen.add(k);
    }
  };
  dupes("entities", doc.entities.map((e) => e.name));
  dupes("screens", doc.screens.map((e) => e.name));
  dupes("services", doc.services.map((e) => e.name));
  dupes("roles", doc.roles.map((e) => e.name));
  dupes("modules", (doc.modules ?? []).map((e) => e.name));
  issues.push(...moduleIssues(doc));

  // References resolve.
  const entityNames = new Set(doc.entities.map((e) => e.name));
  const roleNames = new Set(doc.roles.map((r) => r.name));
  const serviceNames = new Set(doc.services.map((s) => s.name));
  const externalNames = new Set(doc.external_systems.map((s) => s.name));
  const operations = new Map<string, string>();
  doc.services.forEach((s, i) => {
    (s.entities ?? []).forEach((e) => { if (!entityNames.has(e)) issues.push({ path: `/services/${i}/entities`, message: `unknown entity "${e}"` }); });
    (s.consumes ?? []).forEach((c) => {
      if (!serviceNames.has(c) && !externalNames.has(c)) issues.push({ path: `/services/${i}/consumes`, message: `unknown service or external system "${c}"` });
    });
    s.exposes.forEach((op, j) => {
      const key = `${op.method} ${op.path}`;
      if (operations.has(key)) issues.push({ path: `/services/${i}/exposes/${j}`, message: `operation "${key}" also exposed by ${operations.get(key)}` });
      operations.set(key, s.name);
      for (const ent of [op.request_entity, op.response_entity]) if (ent && !entityNames.has(ent)) issues.push({ path: `/services/${i}/exposes/${j}`, message: `unknown entity "${ent}"` });
      (op.roles ?? []).forEach((r) => { if (!roleNames.has(r)) issues.push({ path: `/services/${i}/exposes/${j}/roles`, message: `unknown role "${r}"` }); });
    });
  });
  doc.screens.forEach((s, i) => {
    s.consumes.forEach((op) => { if (!operations.has(op)) issues.push({ path: `/screens/${i}/consumes`, message: `operation "${op}" is not exposed by any service` }); });
    (s.roles ?? []).forEach((r) => { if (!roleNames.has(r)) issues.push({ path: `/screens/${i}/roles`, message: `unknown role "${r}"` }); });
  });
  doc.entities.forEach((e, i) => e.fields.forEach((f, j) => {
    if (f.type === "ref" && (!f.ref || !entityNames.has(f.ref))) issues.push({ path: `/entities/${i}/fields/${j}`, message: `ref field must name a known entity` });
    if (f.type === "enum" && !(f.values && f.values.length)) issues.push({ path: `/entities/${i}/fields/${j}`, message: `enum field needs values` });
  }));
  return issues;
}


/** Modules: references resolve, no file is owned twice, tests are not also implementation files. */
function moduleIssues(doc: IR): IrIssue[] {
  const issues: IrIssue[] = [];
  const modules = doc.modules ?? [];
  const names = new Set(modules.map((m) => m.name));
  const owner = new Map<string, string>();
  modules.forEach((m, i) => {
    (m.uses ?? []).forEach((u) => {
      if (u === m.name) issues.push({ path: `/modules/${i}/uses`, message: `module "${m.name}" uses itself` });
      else if (!names.has(u)) issues.push({ path: `/modules/${i}/uses`, message: `unknown module "${u}"` });
    });
    for (const t of m.tests) if (m.files.includes(t)) issues.push({ path: `/modules/${i}/tests`, message: `"${t}" is listed as both a file and a test` });
    m.files.forEach((f, j) => {
      // Package manifests and lockfiles (any ecosystem) belong to the foundation unit, never to a module.
      if (isManifest(f)) issues.push({ path: `/modules/${i}/files/${j}`, message: `"${f}" is owned by the foundation unit; remove it from files and list the dependency in packages (and say in behaviours if a script such as "test" is needed)` });
    });
    for (const f of [...m.files, ...m.tests]) {
      const prev = owner.get(f);
      if (prev && prev !== m.name) issues.push({ path: `/modules/${i}`, message: `"${f}" belongs to both "${prev}" and "${m.name}"; one unit owns each file` });
      owner.set(f, m.name);
    }
  });
  // uses must not form a cycle
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byName = new Map(modules.map((m) => [m.name, m]));
  const visit = (n: string): boolean => {
    if (done.has(n)) return false;
    if (visiting.has(n)) return true;
    visiting.add(n);
    const cyc = (byName.get(n)?.uses ?? []).some((u) => byName.has(u) && visit(u));
    visiting.delete(n);
    done.add(n);
    return cyc;
  };
  for (const m of modules) if (visit(m.name)) { issues.push({ path: "/modules", message: `modules form a dependency cycle through "${m.name}"` }); break; }
  return issues;
}

export function sealHash(criteria: AcceptanceCriterion[]): string {
  return sha256(stableStringify(criteria));
}

/** Overwrite the fields that code owns: criteria (from the ticket), hashes. */
export function seal(ir: IR, ticketText: string, criteria: AcceptanceCriterion[]): IR {
  return { ...ir, schema: "ai-sdlc.ir.v1", sealed_acceptance_criteria: criteria, sealed_hash: sealHash(criteria), ticket_hash: sha256(ticketText) };
}

/** Hash of the IR for plan provenance (stable, independent of key order). */
export function irHash(ir: IR): string {
  return sha256(stableStringify(ir));
}

// ---------------------------------------------------------------------------------------------
// Ticket text parsing (format defined by the ticket skill).

/** Split plain ticket text into sections keyed by heading (lower-cased). */
export function ticketSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = "_preamble";
  let buf: string[] = [];
  const flush = () => out.set(current, buf.join("\n").trim());
  for (const line of text.split(/\r?\n/)) {
    const heading = headingOf(line);
    if (heading) { flush(); current = heading.name; buf = heading.rest ? [heading.rest] : []; }
    else buf.push(line);
  }
  flush();
  return out;
}

/**
 * A heading is a markdown/Jira-wiki heading line, a bare known heading ("Context:"), or a known heading with its
 * content on the same line ("Roles affected: none"), whose content then starts the section.
 */
function headingOf(line: string): { name: string; rest?: string } | undefined {
  const marked = line.match(/^\s*(?:#{1,6}|h[1-6]\.)\s+(.+?)\s*:?\s*$/);
  if (marked) return { name: marked[1].replace(/[*_]/g, "").trim().toLowerCase() };
  const plain = line.replace(/[*_]/g, "").trim();
  const bare = plain.replace(/:$/, "").toLowerCase();
  if (KNOWN_HEADINGS.has(bare)) return { name: bare };
  const inline = plain.match(/^([A-Za-z][A-Za-z /&-]*?)\s*:\s+(.+)$/);
  if (inline && KNOWN_HEADINGS.has(inline[1].toLowerCase())) return { name: inline[1].toLowerCase(), rest: inline[2] };
  return undefined;
}

const KNOWN_HEADINGS = new Set(["context", "acceptance criteria", "roles affected", "out of scope", "design", "design links", "links", "notes"]);

/** Parse numbered acceptance criteria ("1. ...", "AC-1: ...", "- AC1 ...") from the AC section. */
export function parseAcceptanceCriteria(text: string, heading = "Acceptance criteria"): AcceptanceCriterion[] {
  const section = ticketSections(text).get(heading.toLowerCase());
  if (!section) return [];
  const items: AcceptanceCriterion[] = [];
  let n = 0;
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(?:[-*•]\s*)?(?:AC-?\s*(\d+)\s*[:.)-]?|(\d+)\s*[.)])\s+(.+)$/i);
    // GitHub-style task list items ("- [ ] ..." or "- [x] ..."), numbered in order.
    const box = line.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/);
    if (m) {
      n = Number(m[1] ?? m[2]);
      items.push({ id: `AC-${n}`, text: m[3].trim() });
    } else if (box) {
      n += 1;
      items.push({ id: `AC-${n}`, text: box[1].trim() });
    } else if (line && items.length) {
      const bullet = line.match(/^[-*•]\s+(.+)$/);
      // A bullet under a criterion is part of it (e.g. the cases it must cover); keep it as a list line.
      // Any other line continues the previous criterion or bullet (wrapped text).
      items[items.length - 1].text += bullet ? `\n- ${bullet[1]}` : " " + line;
    }
  }
  // Renumber if the source numbering had gaps or repeats, preserving order.
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length) items.forEach((it, i) => (it.id = `AC-${i + 1}`));
  return items;
}
