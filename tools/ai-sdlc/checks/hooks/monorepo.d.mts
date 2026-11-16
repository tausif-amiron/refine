// Types for monorepo.mjs.
export interface WorkspacePackage { name: string; dir: string }
export interface MonorepoConfig {
  packages: "auto" | WorkspacePackage[];
  checks?: { fast?: string[]; full?: string[] };
  tests?: { command: string };
}
interface ChecksLike { checks?: { fast?: string[]; full?: string[] }; tests?: { command: string }; monorepo?: MonorepoConfig }
export function workspaceGlobs(root: string): string[];
export function workspacePackages(root: string): WorkspacePackage[];
export function packagesOf(root: string, cfg: ChecksLike): WorkspacePackage[];
export function packagesForFiles(pkgs: WorkspacePackage[], files: string[]): WorkspacePackage[];
export function packagesForScope(pkgs: WorkspacePackage[], globs: string[]): WorkspacePackage[];
export function effectiveChecks(cfg: ChecksLike, pkgs: WorkspacePackage[]): { fast: string[]; full: string[] };
export function testRuns(cfg: ChecksLike, pkgs: WorkspacePackage[], files: string[]): { command: string; files: string[] }[];
