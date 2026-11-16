// Types for profile.mjs (stack profiles, profiles/<name>.json).
export interface Profile {
  name: string;
  description?: string;
  detect: string[];
  sourceExtensions: string[];
  manifests: string[];
  packages: {
    install: { pattern: string; name: string; flagsWithValue?: string[]; skip?: string };
    forbidden?: { pattern: string; why: string }[];
  };
  dependencies?: { reader: "json-fields"; file: string; fields: string[] } | { reader: "python" };
  run?: { whenFile?: string; prefix: string }[];
  checks?: { whenDependency?: string; whenPath?: string; unlessPath?: string; command: string; levels: ("fast" | "full")[] }[];
  scripts?: {
    reader: "json-field";
    file: string;
    field: string;
    known: string[];
    command: Record<string, string>;
    runs: string;
  };
  tests: {
    globs: string[];
    report: "jest-json" | "junit";
    runners: { whenDependency: string; command: string }[];
    runnerPattern?: string;
    /** Names of pin tests: tests that guard behaviour the ticket says must stay unchanged. */
    pinPattern?: string;
  };
  lint?: { whenDependency: string; lintChanged: string; format: "eslint-json" | "ruff-json"; stdinArgs: string; configFiles: string[] };
  mutation: { operators: string };
  routes?: { pattern: string; authPattern: string; sourceDirs?: string[] };
  app?: { startScripts: string[] };
  /** Claude Code permission rules agent runs need for this toolchain (merged into client settings by the installer). */
  permissions?: string[];
  /** Installed environments that are not in git (node_modules, .venv): linked into unit worktrees. */
  environments?: string[];
  /** Tool caches that are not in git (.mypy_cache, ...): copied into unit worktrees so checks start warm. */
  caches?: string[];
}

export const PROFILES_DIR: string;
export function profilesDir(): string;
export function loadProfile(name: string): Profile;
export function allProfiles(): Profile[];
export function detectProfiles(root: string): Profile[];
export function profilesFor(root: string, cfg?: { profiles?: string[] }): Profile[];
export function isManifest(path: string, profiles?: Profile[]): boolean;
export function profileForFile(path: string, profiles?: Profile[]): Profile | undefined;
export function installDecision(command: string, brief: { kind?: string; packages?: string[] }, profiles?: Profile[]): string | undefined;
export function forbiddenCommand(command: string, profiles?: Profile[]): string | undefined;
export function readDependencies(root: string, profiles: Profile[]): Set<string>;
export function readScripts(root: string, profiles: Profile[]): Record<string, string>;
export function scriptCommand(profile: Profile, script: string): string;
export function scriptOfCommand(profile: Profile, command: string): string | undefined;
export function packageArgs(profile: Profile, args: string): string[];
export function readPythonDependencies(root: string): Set<string>;
export function runPrefix(root: string, profile: Profile): string;
export function withRunner(root: string, profile: Profile, command: string): string;
export function toolChecks(root: string, profile: Profile, deps: Set<string>): { fast: string[]; full: string[] };
export function scriptRuns(profile: Profile, script: string, command: string): boolean;
