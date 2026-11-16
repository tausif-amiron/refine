// owed.yaml: open hand-offs between units. Format: docs/CONVENTIONS.md#owed-yaml.
// The orchestrator owns the canonical copy on the ticket branch; agents edit the copy in their
// worktree and mergeOwed() folds their changes back in, rejecting changes they may not make.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import type { OwedEntry } from "./types.ts";

const KINDS = new Set(["interface", "screen", "fixture", "data", "dependency", "wiring"]);
const HEADER = `# Open hand-offs between units. Schema: docs/CONVENTIONS.md#owed-yaml
# The loop fails a provider while an entry addressed to it is open,
# and holds a consumer (blocked) until the entries it opened are closed.
`;

export function parseOwed(text: string): { entries: OwedEntry[]; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown;
  try { raw = parse(text) ?? []; } catch (e) { return { entries: [], errors: [`owed.yaml is not valid YAML: ${String(e)}`] }; }
  if (!Array.isArray(raw)) return { entries: [], errors: ["owed.yaml must be a list"] };
  const ids = new Set<string>();
  const entries: OwedEntry[] = [];
  raw.forEach((x: Record<string, unknown>, i) => {
    const where = `owed.yaml[${i}]`;
    for (const k of ["id", "from", "to", "kind", "status"]) if (typeof x?.[k] !== "string" || !x[k]) errors.push(`${where}: missing "${k}"`);
    if (x?.kind && !KINDS.has(String(x.kind))) errors.push(`${where}: kind must be one of ${[...KINDS].join(", ")}`);
    if (x?.status && x.status !== "open" && x.status !== "closed") errors.push(`${where}: status must be open or closed`);
    if (x?.from && x.from === x.to) errors.push(`${where}: from and to are the same unit`);
    if (x?.id) { if (ids.has(String(x.id))) errors.push(`${where}: duplicate id ${x.id}`); ids.add(String(x.id)); }
    entries.push(x as unknown as OwedEntry);
  });
  return { entries, errors };
}

export function loadOwed(path: string): OwedEntry[] {
  if (!existsSync(path)) return [];
  const { entries, errors } = parseOwed(readFileSync(path, "utf8"));
  if (errors.length) throw new Error(errors.join("\n"));
  return entries;
}

export function formatOwed(entries: OwedEntry[]): string {
  const ordered = [...entries].sort((a, b) => a.id.localeCompare(b.id)).map((e) => {
    const o: Record<string, unknown> = { id: e.id, from: e.from, to: e.to, kind: e.kind };
    if (e.contract) o.contract = e.contract;
    if (e.note) o.note = e.note;
    o.status = e.status;
    if (e.opened_by) o.opened_by = e.opened_by;
    return o;
  });
  return HEADER + (ordered.length ? stringify(ordered, { lineWidth: 0 }) : "[]\n");
}

export function saveOwed(path: string, entries: OwedEntry[]): void {
  writeFileSync(path, formatOwed(entries));
}

/** Entries the unit must deliver (it is the provider). */
export const openTo = (entries: OwedEntry[], unit: string) => entries.filter((e) => e.status === "open" && e.to === unit);
/** Entries the unit opened that are still open (it is the consumer). */
export const openFrom = (entries: OwedEntry[], unit: string) => entries.filter((e) => e.status === "open" && e.from === unit);
/**
 * Entries that hold the consumer until delivered. "wiring" hand-offs do not block: the wiring unit runs
 * after every feature unit, so blocking on it would deadlock.
 */
export const blockingFrom = (entries: OwedEntry[], unit: string) => openFrom(entries, unit).filter((e) => e.kind !== "wiring");

export interface OwedMerge {
  merged: OwedEntry[];
  added: OwedEntry[];
  closed: OwedEntry[];
  violations: string[];
}

/**
 * Fold an agent's edited owed.yaml into the canonical list.
 * - New entries must be opened by the acting unit (from === actor) and address a known unit.
 * - Only the provider (to === actor) may close an entry. Nobody may reopen or rewrite one.
 * - Deleting an entry is a violation (close it instead).
 */
export function mergeOwed(canonical: OwedEntry[], edited: OwedEntry[], actor: string, knownUnits: Set<string>, runId?: string): OwedMerge {
  const byId = new Map(canonical.map((e) => [e.id, { ...e }]));
  const editedIds = new Set(edited.map((e) => e.id));
  const added: OwedEntry[] = [];
  const closed: OwedEntry[] = [];
  const violations: string[] = [];

  for (const e of canonical) if (!editedIds.has(e.id)) violations.push(`${actor} deleted owed entry ${e.id}; close it instead`);

  for (const e of edited) {
    const prev = byId.get(e.id);
    if (!prev) {
      if (e.from !== actor) { violations.push(`${actor} opened ${e.id} on behalf of ${e.from}`); continue; }
      if (!knownUnits.has(e.to)) { violations.push(`${e.id} addresses unknown unit ${e.to}`); continue; }
      if (e.status !== "open") { violations.push(`${e.id} must be opened with status: open`); continue; }
      const entry = { ...e, opened_by: e.opened_by ?? runId };
      byId.set(e.id, entry);
      added.push(entry);
      continue;
    }
    const changedFields = (["from", "to", "kind", "contract", "note"] as const).filter((k) => (prev[k] ?? "") !== (e[k] ?? ""));
    if (changedFields.length) violations.push(`${actor} rewrote ${e.id} (${changedFields.join(", ")})`);
    if (prev.status !== e.status) {
      if (prev.status === "open" && e.status === "closed" && prev.to === actor) {
        prev.status = "closed";
        closed.push(prev);
      } else {
        violations.push(`${actor} may not change ${e.id} from ${prev.status} to ${e.status}`);
      }
    }
  }
  return { merged: [...byId.values()], added, closed, violations };
}
