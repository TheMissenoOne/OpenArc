// Contracts shared by every region. These types are authoritative and hand-written.
// OpenArc never generates or edits this file.
import type { Json } from "openarc";

// ---------- diagnostics (spec §11) ----------
// No message field: messages come from a table keyed by code. Examples compare
// codes and structured `detail` tokens, never prose. Absent fields are OMITTED, not set
// to undefined, because examples use deep strict equality.
export type DiagnosticCode = `OARC-${"E" | "W"}${string}`;
export interface Diagnostic {
  code: DiagnosticCode;
  id?: string;
  file?: string;
  line?: number;
  detail?: string;
}

// ---------- markers and region tree (spec §3) ----------
export interface Marker {
  kind: "begin" | "end";
  id: string;
  line: number; // 1-based
}
export interface RegionNode {
  id: string;
  beginLine: number;
  endLine: number;
  children: RegionNode[];
}
/** A direct child's span inside a parent body. Indices into the body's line array, inclusive, markers included. */
export interface ChildSpan {
  id: string;
  from: number;
  to: number;
}

// ---------- ownership (spec §6) ----------
export type Ownership = "compiler" | "developer" | "conflicted";
export type RegionState = Ownership | "pending";
export interface ManifestView {
  ownership: Ownership;
  hash: string;
  specHash: string;
  parent: string | null;
}
export interface ObservedRegion {
  present: boolean; // markers found
  pending: boolean; // body is exactly `arc.todo("<id>")`
  parent: string | null;
  hash: string;
  specHash: string;
}
export interface OwnershipResult {
  state: RegionState;
  diagnostic: Diagnostic | null;
}

// ---------- planning (spec §8.1 PLAN) ----------
export interface PlanInput {
  id: string;
  parent: string | null;
  state: RegionState;
  stale: boolean; // fingerprint differs from the manifest
}
export interface PlanResult {
  targets: string[];
  skipped: Diagnostic[];
}

// ---------- model backend (spec §8.4) ----------
export interface ImportDecl {
  from: string;
  names: string[];
}
export type ModelOutput =
  | { ok: true; body: string; imports: ImportDecl[] }
  | { ok: false; diagnostic: Diagnostic };
export interface ModelConfig {
  host: string;
  model: string;
  seed: number;
  numCtx: number;
}
export interface OllamaChatRequest {
  model: string;
  stream: false;
  format: Json;
  options: { temperature: 0; seed: number; num_ctx: number };
  messages: { role: "system" | "user"; content: string }[];
  think?: boolean; // set by backends.ts from BackendConfig.think, not by model.buildRequest
  keep_alive?: string; // set by backends.ts from BackendConfig.keepAlive, not by model.buildRequest
}
export type Rendered = { ok: true; text: string } | { ok: false; missing: string[] };

// ---------- sandbox (spec §9.2) ----------
export interface SandboxConfig {
  stageDir: string;
  nodeBin: string; // RESOLVED binary, never a version-manager shim
  nodePrefix: string; // install prefix that contains nodeBin
  heapMb: number;
  addressSpaceBytes: number; // >= 16 GiB: V8's cage plus the WASM type stripper (amaro) reserve virtual memory
  cpuSeconds: number;
  regionId: string;
}
export interface ExampleOutcome {
  name: string;
  ok: boolean;
  actual?: Json;
}
export interface HarnessSummary {
  complete: boolean; // harness printed its final {"done":n} line
  passed: number;
  failed: ExampleOutcome[];
}

// ---------- transactions (spec §8.1 STAGE/COMMIT, §8.2) ----------
export interface JournalEntry {
  target: string;
  staged: string;
  backup: string;
}
export interface Journal {
  txid: string;
  entries: JournalEntry[];
}

// ---------- CLI (spec §6.3) ----------
export type Command =
  | { cmd: "compile"; ids: string[] }
  | { cmd: "scaffold" }
  | { cmd: "init" }
  | { cmd: "freeze" | "release" | "inspect"; id: string }
  | { cmd: "resolve"; id: string; mode: "keep" | "regen" | "unlink" }
  | { cmd: "graph" }
  | { cmd: "extract"; file: string; fn?: string; id?: string } // spec §10; absent flags are omitted
  | { cmd: "watch"; debounceMs: number } // spec §15
  | { cmd: "usage"; reason: "unknown-command" | "missing-id" | "resolve-needs-mode" | "missing-file" | "bad-flag" };

// ---------- ports: every effect arrives through a parameter (spec §7.5) ----------
/** Paths are project-relative POSIX. `remove` deletes a file or a whole directory tree. `list` returns direct child names, sorted. */
export interface FsPort {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  createExclusive(path: string): Promise<boolean>;
}
export interface HttpPort {
  /** headers may carry secrets (API keys): never log or snapshot them. */
  postJson(url: string, body: Json, headers?: Record<string, string>): Promise<string>;
  get(url: string): Promise<string>;
}
export interface ProcPort {
  run(argv: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; timedOut: boolean }>;
}
export interface Ports {
  fs: FsPort;
  http: HttpPort;
  proc: ProcPort;
  now(): string;
  newTxId(): string;
  log(line: string): void;
}

// ---------- compiler pipeline ----------
/** ports.fs is already rooted at the project directory. */
export interface CompileRequest {
  root: string; // absolute project path; used ONLY to build sandbox bind paths
  ids: string[];
  keepGoing?: boolean; // commit the targets that passed; failed ones stay pending
  model: ModelConfig;
  sandbox: Omit<SandboxConfig, "stageDir" | "regionId">;
}
export interface CompileResult {
  exit: 0 | 1;
  diagnostics: Diagnostic[];
  modelCalls: number;
}
export interface SourceText {
  file: string;
  text: string;
}
export interface AnalyzedRegion {
  id: string;
  kind: "function" | "block";
  file: string;
  parent: string | null;
  state: RegionState;
  stale: boolean;
  fingerprint: string;
}
export interface Candidate {
  id: string;
  body: string;
  imports: ImportDecl[];
  verifiedBy: string[];
}
export interface StagedFile {
  target: string;
  text: string;
}
