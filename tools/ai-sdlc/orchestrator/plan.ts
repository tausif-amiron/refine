// Stage 1 planner. Deterministic: no model calls, no clocks, no randomness. Same IR in,
// byte-identical plan and contract files out. verifyPlan() is the planner test the build
// plan asks for: every screen and endpoint is planned exactly once.
import picomatch from "picomatch";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { Config } from "./config.ts";
import { modelFor } from "./config.ts";
import { irHash } from "./ir.ts";
import type { ContractFile, IR, IrEntity, IrField, IrOperation, IrPackage, Plan, Unit, UnitKind } from "./types.ts";
import { kebab, stableStringify } from "./util.ts";

const KIND_RANK: Record<UnitKind, number> = { foundation: 0, "data-model": 1, "legacy-wrapper": 2, service: 3, screen: 4, module: 5, wiring: 6, walk: 7 };

export function unitId(kind: UnitKind, name: string): string {
  const prefix = kind === "data-model" ? "data" : kind === "legacy-wrapper" ? "wrapper" : kind;
  return kind === "foundation" || kind === "walk" || kind === "wiring" ? `unit-${kind}` : `unit-${prefix}-${kebab(name)}`;
}

export function opKey(op: Pick<IrOperation, "method" | "path">): string {
  return `${op.method} ${op.path}`;
}

export function buildPlan(ir: IR, cfg: Config): Plan {
  const scopeFor = (kind: UnitKind, slug: string) =>
    [...(cfg.scope[kind] ?? []), ...(cfg.scope.always ?? [])].map((g) => g.replaceAll("{name}", slug));

  const contracts: ContractFile[] = [];
  const units: Unit[] = [];
  const entityByName = new Map(ir.entities.map((e) => [e.name, e]));
  const serviceByOp = new Map<string, string>();
  for (const s of ir.services) for (const op of s.exposes) serviceByOp.set(opKey(op), s.name);
  const serviceNames = new Set(ir.services.map((s) => s.name));

  const foundation: Unit = {
    id: unitId("foundation", "foundation"), kind: "foundation", name: "foundation", slug: "foundation",
    agent: "dev-backend", model: modelFor(cfg, "foundation"), dependsOn: [],
    scope: scopeFor("foundation", "foundation"), exposes: [], consumes: [],
    ir: { entities: [], services: [], screens: [] },
  };
  // Packages the modules need are added by the foundation unit, which owns package.json and lockfiles.
  const packages = mergePackages((ir.modules ?? []).flatMap((m) => m.packages ?? []));
  if (packages.length) foundation.packages = packages;
  // A ticket of modules only, needing no packages, has no foundation work (no auth, data, config or dependencies).
  const needsFoundation = packages.length > 0 || ir.entities.length > 0 || ir.services.length > 0 || ir.screens.length > 0;
  if (needsFoundation) units.push(foundation);
  const foundationDeps = needsFoundation ? [foundation.id] : [];

  for (const e of sortByName(ir.entities)) {
    const slug = kebab(e.name);
    const id = unitId("data-model", e.name);
    const dbPath = `contracts/db/${slug}.json`;
    contracts.push({ path: dbPath, owner: id, content: stableStringify(dbContract(ir.ticket, id, e)) });
    const refs = e.fields.filter((f) => f.type === "ref" && f.ref).map((f) => unitId("data-model", f.ref!));
    units.push({
      id, kind: "data-model", name: e.name, slug, agent: "dev-backend", model: modelFor(cfg, "dev-backend"),
      dependsOn: uniqSorted([foundation.id, ...refs.filter((r) => r !== id)]),
      scope: scopeFor("data-model", slug), exposes: [dbPath],
      consumes: uniqSorted(e.fields.filter((f) => f.type === "ref" && f.ref).map((f) => `contracts/db/${kebab(f.ref!)}.json`)),
      ir: { entities: [e.name], services: [], screens: [] },
    });
  }

  for (const s of sortByName(ir.services)) {
    const kind: UnitKind = s.kind === "legacy-wrapper" ? "legacy-wrapper" : "service";
    const slug = kebab(s.name);
    const id = unitId(kind, s.name);
    const apiPath = `contracts/openapi/${slug}.yaml`;
    const usedEntities = uniqSorted([...(s.entities ?? []), ...s.exposes.flatMap((o) => [o.request_entity, o.response_entity]).filter(Boolean) as string[]]);
    contracts.push({ path: apiPath, owner: id, content: openApiContract(ir, s.name, id, s.exposes, usedEntities.map((n) => entityByName.get(n)!).filter(Boolean)) });
    const exposes = [apiPath];
    for (const ev of [...(s.emits ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      const p = `contracts/events/${ev.name}.json`;
      contracts.push({ path: p, owner: id, content: stableStringify(eventContract(ir.ticket, id, ev.name, ev.entity ? entityByName.get(ev.entity) : undefined)) });
      exposes.push(p);
    }
    const consumedServices = (s.consumes ?? []).filter((c) => serviceNames.has(c) && c !== s.name);
    units.push({
      id, kind, name: s.name, slug, agent: "dev-backend", model: modelFor(cfg, "dev-backend"),
      dependsOn: uniqSorted([
        foundation.id,
        ...usedEntities.map((e) => unitId("data-model", e)),
        ...consumedServices.map((c) => unitId(kindOfService(ir, c), c)),
      ]),
      scope: scopeFor(kind, slug), exposes: exposes.sort(),
      consumes: uniqSorted([...usedEntities.map((e) => `contracts/db/${kebab(e)}.json`), ...consumedServices.map((c) => `contracts/openapi/${kebab(c)}.yaml`)]),
      ir: { entities: usedEntities, services: [s.name], screens: [] },
    });
  }

  for (const sc of sortByName(ir.screens)) {
    const slug = kebab(sc.name);
    const providers = uniqSorted(sc.consumes.map((op) => serviceByOp.get(op)).filter(Boolean) as string[]);
    units.push({
      id: unitId("screen", sc.name), kind: "screen", name: sc.name, slug, agent: "dev-frontend", model: modelFor(cfg, "dev-frontend"),
      dependsOn: uniqSorted([foundation.id, ...providers.map((p) => unitId(kindOfService(ir, p), p))]),
      scope: scopeFor("screen", slug), exposes: [],
      consumes: providers.map((p) => `contracts/openapi/${kebab(p)}.yaml`),
      ir: { entities: [], services: providers, screens: [sc.name] },
    });
  }

  // Modules: code changes that are not entities, screens or services. SCOPE is exactly the listed
  // files and tests (plus owed.yaml), so a module unit cannot touch anything else.
  for (const m of sortByName(ir.modules ?? [])) {
    const slug = kebab(m.name);
    units.push({
      id: unitId("module", m.name), kind: "module", name: m.name, slug, agent: "dev-module", model: modelFor(cfg, "dev-module"),
      dependsOn: uniqSorted([...foundationDeps, ...(m.uses ?? []).map((u) => unitId("module", u))]),
      scope: uniqSorted([...m.files, ...m.tests, ...(cfg.scope.always ?? [])]), exposes: [], consumes: [],
      ir: { entities: [], services: [], screens: [], modules: [m.name] },
    });
  }

  // Wiring: the shared files no feature unit owns (routes, nav, app/server registration). Runs after
  // every screen and service; registers each of them and takes "wiring" hand-offs from owed.yaml.
  // Not planned when the ticket has no screens or services (nothing to register).
  const built = units.filter((u) => u.kind === "screen" || u.kind === "service" || u.kind === "legacy-wrapper").map((u) => u.id).sort();
  const moduleIds = units.filter((u) => u.kind === "module").map((u) => u.id).sort();
  if (built.length) {
    units.push({
      id: unitId("wiring", "wiring"), kind: "wiring", name: "wiring", slug: "wiring", agent: "dev-wiring", model: modelFor(cfg, "dev-wiring"),
      dependsOn: built,
      scope: scopeFor("wiring", "wiring"), exposes: [],
      consumes: contracts.filter((c) => c.path.startsWith("contracts/openapi/")).map((c) => c.path).sort(),
      ir: { entities: [], services: ir.services.map((s) => s.name).sort(), screens: ir.screens.map((s) => s.name).sort() },
    });
  }

  units.push({
    id: unitId("walk", "walk"), kind: "walk", name: "walk", slug: "walk", agent: "qa", model: modelFor(cfg, "qa"),
    dependsOn: [...built, ...moduleIds, ...(built.length ? [unitId("wiring", "wiring")] : [])].sort(),
    scope: scopeFor("walk", "walk"), exposes: [],
    consumes: contracts.filter((c) => c.path.startsWith("contracts/openapi/")).map((c) => c.path).sort(),
    ir: { entities: [], services: ir.services.map((s) => s.name).sort(), screens: ir.screens.map((s) => s.name).sort(), modules: (ir.modules ?? []).map((m) => m.name).sort() },
  });

  return {
    schema: "ai-sdlc.plan.v1",
    ticket: ir.ticket,
    ir_hash: irHash(ir),
    units: topoSort(units),
    contracts: contracts.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** One entry per package; runtime wins over dev if both are asked for; first version given wins. */
export function mergePackages(pkgs: IrPackage[]): IrPackage[] {
  const by = new Map<string, IrPackage>();
  for (const p of pkgs) {
    const prev = by.get(p.name);
    if (!prev) by.set(p.name, { name: p.name, ...(p.dev ? { dev: true } : {}), ...(p.version ? { version: p.version } : {}) });
    else {
      if (!p.dev) delete prev.dev;
      if (!prev.version && p.version) prev.version = p.version;
    }
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function kindOfService(ir: IR, name: string): UnitKind {
  return ir.services.find((s) => s.name === name)?.kind === "legacy-wrapper" ? "legacy-wrapper" : "service";
}

function sortByName<T extends { name: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.name.localeCompare(b.name));
}

function uniqSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/** Kahn's algorithm with a deterministic tie-break (kind rank, then id). Throws on cycles. */
export function topoSort(units: Unit[]): Unit[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const indeg = new Map(units.map((u) => [u.id, u.dependsOn.filter((d) => byId.has(d)).length]));
  const order: Unit[] = [];
  const cmp = (a: Unit, b: Unit) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id);
  let ready = units.filter((u) => indeg.get(u.id) === 0).sort(cmp);
  while (ready.length) {
    const u = ready.shift()!;
    order.push(u);
    for (const v of units) {
      if (v.dependsOn.includes(u.id)) {
        indeg.set(v.id, indeg.get(v.id)! - 1);
        if (indeg.get(v.id) === 0) ready.push(v);
      }
    }
    ready.sort(cmp);
  }
  if (order.length !== units.length) {
    const stuck = units.filter((u) => !order.includes(u)).map((u) => u.id);
    throw new Error(`dependency cycle among units: ${stuck.join(", ")}`);
  }
  return order;
}

/** Group units into levels: every unit's dependencies are in earlier levels. Units in a level can run in parallel. */
export function levels(plan: Plan): Unit[][] {
  const level = new Map<string, number>();
  for (const u of plan.units) level.set(u.id, Math.max(-1, ...u.dependsOn.map((d) => level.get(d) ?? -1)) + 1);
  const out: Unit[][] = [];
  for (const u of plan.units) (out[level.get(u.id)!] ??= []).push(u);
  return out;
}

export interface PlanIssue { message: string }

/** The planner test: coverage exactly once, dependencies exist and point backwards, one owner per contract. */
export function verifyPlan(ir: IR, plan: Plan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const ids = new Set<string>();
  plan.units.forEach((u, i) => {
    if (ids.has(u.id)) issues.push({ message: `duplicate unit id ${u.id}` });
    ids.add(u.id);
    for (const d of u.dependsOn) {
      const j = plan.units.findIndex((x) => x.id === d);
      if (j < 0) issues.push({ message: `${u.id} depends on unknown unit ${d}` });
      else if (j >= i) issues.push({ message: `${u.id} depends on ${d}, which is not planned before it` });
    }
    if (!u.scope.length) issues.push({ message: `${u.id} has an empty SCOPE` });
  });
  for (const sc of ir.screens) {
    const n = plan.units.filter((u) => u.kind === "screen" && u.ir.screens.includes(sc.name)).length;
    if (n !== 1) issues.push({ message: `screen "${sc.name}" planned ${n} times (expected 1)` });
  }
  for (const s of ir.services) for (const op of s.exposes) {
    const key = opKey(op);
    const owners = plan.contracts.filter((c) => c.path.startsWith("contracts/openapi/") && contractHasOp(c.content, op));
    if (owners.length !== 1) issues.push({ message: `endpoint "${key}" planned ${owners.length} times (expected 1)` });
  }
  for (const e of ir.entities) {
    const n = plan.units.filter((u) => u.kind === "data-model" && u.ir.entities.includes(e.name)).length;
    if (n !== 1) issues.push({ message: `entity "${e.name}" planned ${n} times (expected 1)` });
  }
  for (const m of ir.modules ?? []) {
    const n = plan.units.filter((u) => u.kind === "module" && (u.ir.modules ?? []).includes(m.name)).length;
    if (n !== 1) issues.push({ message: `module "${m.name}" planned ${n} times (expected 1)` });
    // A module's files must not also fall inside another unit's SCOPE: one unit owns each file.
    for (const f of [...m.files, ...m.tests]) {
      for (const u of plan.units) {
        if (u.kind === "module" || u.kind === "walk") continue;
        const g = u.scope.filter((x) => x !== "owed.yaml").find((x) => picomatch(x, { dot: true })(f));
        if (g) issues.push({ message: `module "${m.name}" file ${f} is also inside ${u.id}'s SCOPE (${g})` });
      }
    }
  }
  const owners = new Map<string, string>();
  for (const c of plan.contracts) {
    if (owners.has(c.path)) issues.push({ message: `contract ${c.path} has two owners` });
    owners.set(c.path, c.owner);
    const owner = plan.units.find((u) => u.id === c.owner);
    if (!owner || !owner.exposes.includes(c.path)) issues.push({ message: `contract ${c.path} owner ${c.owner} does not expose it` });
  }
  return issues;
}

function contractHasOp(yamlText: string, op: Pick<IrOperation, "method" | "path">): boolean {
  const doc = yamlParse(yamlText) as { paths?: Record<string, Record<string, unknown>> };
  return Boolean(doc?.paths?.[openApiPath(op.path)]?.[op.method.toLowerCase()]);
}

// ---------------------------------------------------------------------------------------------
// Contract emitters

/** "/invoices/:id" → "/invoices/{id}" */
export function openApiPath(p: string): string {
  return p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function schemaName(entity: string): string {
  return entity.replace(/(^|[\s_-]+)([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase());
}

function fieldSchema(f: IrField): Record<string, unknown> {
  switch (f.type) {
    case "integer": return { type: "integer" };
    case "number": return { type: "number" };
    case "money": return { type: "string", pattern: "^-?[0-9]+(\\.[0-9]{1,2})?$", description: "decimal amount as string" };
    case "boolean": return { type: "boolean" };
    case "date": return { type: "string", format: "date" };
    case "datetime": return { type: "string", format: "date-time" };
    case "enum": return { type: "string", enum: [...(f.values ?? [])] };
    case "id": return { type: "string" };
    case "ref": return { type: "string", description: `id of ${f.ref}` };
    default: return { type: "string" };
  }
}

function entitySchema(e: IrEntity): Record<string, unknown> {
  const properties: Record<string, unknown> = { id: { type: "string" } };
  for (const f of e.fields) properties[f.name] = { ...fieldSchema(f), ...(f.pii ? { "x-pii": true } : {}) };
  const required = ["id", ...e.fields.filter((f) => f.required && f.name !== "id").map((f) => f.name)];
  return { type: "object", additionalProperties: false, required, properties };
}

function openApiContract(ir: IR, service: string, owner: string, ops: IrOperation[], entities: IrEntity[]): string {
  const paths: Record<string, Record<string, unknown>> = {};
  const sortedOps = [...ops].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const op of sortedOps) {
    const p = openApiPath(op.path);
    const pathParams = [...op.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    const parameters = [
      ...pathParams.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      ...(op.query ?? []).map((name) => ({ name, in: "query", required: false, schema: { type: "string" } })),
    ];
    const ref = (e: string) => ({ $ref: `#/components/schemas/${schemaName(e)}` });
    const okSchema = op.response_entity ? (op.response_list ? { type: "array", items: ref(op.response_entity) } : ref(op.response_entity)) : { type: "object" };
    const success = op.method === "POST" ? "201" : op.method === "DELETE" ? "204" : "200";
    const responses: Record<string, unknown> = {
      [success]: success === "204" ? { description: "No content" } : { description: "OK", content: { "application/json": { schema: okSchema } } },
      "400": { $ref: "#/components/responses/Error" },
      "401": { $ref: "#/components/responses/Error" },
      "403": { $ref: "#/components/responses/Error" },
    };
    if (pathParams.length) responses["404"] = { $ref: "#/components/responses/Error" };
    const operation: Record<string, unknown> = {
      operationId: camel(`${op.method.toLowerCase()} ${op.path.replace(/[/:{}]+/g, " ")}`),
      summary: op.summary ?? `${op.method} ${op.path}`,
      "x-roles": [...(op.roles ?? [])].sort(),
      ...(parameters.length ? { parameters } : {}),
      ...(op.request_entity ? { requestBody: { required: true, content: { "application/json": { schema: ref(op.request_entity) } } } } : {}),
      responses,
    };
    (paths[p] ??= {})[op.method.toLowerCase()] = operation;
  }
  const schemas: Record<string, unknown> = {};
  for (const e of [...entities].sort((a, b) => a.name.localeCompare(b.name))) schemas[schemaName(e.name)] = entitySchema(e);
  schemas.Error = {
    type: "object", required: ["error"],
    properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "object" } } } },
  };
  const doc = {
    openapi: "3.1.0",
    info: { title: `${service} service`, version: "0.1.0", "x-ticket": ir.ticket, "x-owner": owner },
    paths,
    components: {
      schemas,
      responses: { Error: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
    security: [{ bearer: [] }],
  };
  return `# Generated by the planner from ir/${ir.ticket}.ir.json. Owner: ${owner}. Do not edit by hand.\n` + yamlStringify(doc, { lineWidth: 0 });
}

function camel(s: string): string {
  return s.trim().split(/\s+/).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("");
}

function dbContract(ticket: string, owner: string, e: IrEntity) {
  const sqlType = (f: IrField) => ({ integer: "integer", number: "double precision", money: "numeric(18,2)", boolean: "boolean", date: "date", datetime: "timestamptz", text: "text" } as Record<string, string>)[f.type] ?? "text";
  return {
    $comment: `Generated by the planner from ir/${ticket}.ir.json. Owner: ${owner}.`,
    table: kebab(e.name).replace(/-/g, "_"),
    primary_key: "id",
    columns: [
      { name: "id", type: "text", nullable: false },
      ...e.fields.filter((f) => f.name !== "id").map((f) => ({
        name: f.name, type: sqlType(f), nullable: !f.required,
        ...(f.pii ? { pii: true } : {}),
        ...(f.type === "enum" ? { check_values: f.values } : {}),
        ...(f.type === "ref" ? { references: `${kebab(f.ref!).replace(/-/g, "_")}.id` } : {}),
      })),
      { name: "created_at", type: "timestamptz", nullable: false },
      { name: "updated_at", type: "timestamptz", nullable: false },
    ],
  };
}

function eventContract(ticket: string, owner: string, name: string, entity?: IrEntity) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $comment: `Generated by the planner from ir/${ticket}.ir.json. Owner: ${owner}.`,
    title: name,
    type: "object",
    required: ["event", "occurred_at", "data"],
    properties: {
      event: { const: name },
      occurred_at: { type: "string", format: "date-time" },
      data: entity ? entitySchema(entity) : { type: "object" },
    },
  };
}
