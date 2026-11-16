// Shared types for the orchestrator. The IR types mirror ir/schema.json.

export interface Anchor { quote: string; section?: string }

export interface AcceptanceCriterion { id: string; text: string }

export interface IrField {
  name: string;
  type: string;
  required?: boolean;
  pii?: boolean;
  values?: string[];
  ref?: string;
}

export interface IrEntity { name: string; fields: IrField[]; anchor: Anchor }
export interface IrRole { name: string; permissions: string[]; anchor: Anchor }
export interface IrScreen { name: string; states: string[]; roles?: string[]; consumes: string[]; anchor: Anchor }

export interface IrOperation {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary?: string;
  roles?: string[];
  request_entity?: string;
  response_entity?: string;
  response_list?: boolean;
  query?: string[];
}

export interface IrService {
  name: string;
  kind: "service" | "legacy-wrapper";
  entities?: string[];
  exposes: IrOperation[];
  consumes?: string[];
  emits?: { name: string; entity?: string }[];
  anchor: Anchor;
}

export interface IrExternalSystem { name: string; access: string; rate_limit?: string; anchor: Anchor }
export interface IrLimit { kind: string; value: string; anchor: Anchor }
export interface IrPackage { name: string; dev?: boolean; version?: string }
export interface IrModule {
  name: string;
  files: string[];
  tests: string[];
  behaviours: string[];
  packages?: IrPackage[];
  uses?: string[];
  anchor: Anchor;
}
export interface IrQuestion { q: string; affects: string; if_wrong: string; answer?: string }

export interface IR {
  schema: "ai-sdlc.ir.v1";
  ticket: string;
  title: string;
  ticket_hash: string;
  sealed_hash: string;
  sealed_acceptance_criteria: AcceptanceCriterion[];
  entities: IrEntity[];
  roles: IrRole[];
  screens: IrScreen[];
  services: IrService[];
  external_systems: IrExternalSystem[];
  limits: IrLimit[];
  modules?: IrModule[];
  unplaced: { text: string; reason: string }[];
  questions: IrQuestion[];
}

export type UnitKind = "foundation" | "data-model" | "service" | "legacy-wrapper" | "screen" | "module" | "wiring" | "walk";
export type AgentName = "dev-frontend" | "dev-backend" | "dev-module" | "dev-wiring" | "qa";

export interface Unit {
  id: string;
  kind: UnitKind;
  name: string;            // IR name, or "foundation" / "walk"
  slug: string;            // kebab-case name used in paths
  agent: AgentName;
  model: string;
  dependsOn: string[];
  scope: string[];         // globs the unit may edit
  exposes: string[];       // contract files this unit owns
  consumes: string[];      // contract files this unit reads
  ir: { entities: string[]; services: string[]; screens: string[]; modules?: string[] };
  /** Foundation only: packages to add, from modules[].packages. */
  packages?: IrPackage[];
}

export interface ContractFile { path: string; content: string; owner: string }

export interface Plan {
  schema: "ai-sdlc.plan.v1";
  ticket: string;
  ir_hash: string;
  units: Unit[];
  contracts: ContractFile[];
}

export interface OwedEntry {
  id: string;
  from: string;
  to: string;
  kind: "interface" | "screen" | "fixture" | "data" | "dependency" | "wiring";
  contract?: string;
  note?: string;
  status: "open" | "closed";
  opened_by?: string;
}

export interface Brief {
  schema: "ai-sdlc.brief.v1";
  ticket: string;
  unit: string;
  kind: UnitKind;
  agent: AgentName;
  run_id: string;
  attempt: number;
  base_commit: string;     // commit the brief was issued at
  scope: string[];
  tests: string[];         // test globs inside scope
  packages?: string[];     // foundation only: package names it may install
  /** Monorepo: the workspace packages this unit touches, and the checks resolved for them (gates and hooks use these). */
  workspaces?: { name: string; dir: string }[];
  checks?: { fast: string[]; full: string[] };
  issued_at: string;
}

export type RunStatus = "pass" | "fail" | "escalated" | "blocked" | "error" | "info";

export interface AgentRunResult {
  ok: boolean;             // the process completed (not whether the unit passes)
  text: string;            // final message
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  cost_source: "cli" | "sdk" | "unknown" | "fake";
  session_id?: string;
  raw?: unknown;
}

/** setup: the gate's own tool could not run (a configuration problem a person fixes, not the agent's work). */
export interface GateResult { name: string; pass: boolean; output: string; setup?: boolean }
