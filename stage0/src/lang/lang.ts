// The language seam: what decompile.ts, arcsync.ts and levels.ts need from a language. One implementation per
// language (lang/ts.ts for TypeScript and JavaScript, lang/go.ts for Go), picked per file by extension. Everything else
// stays language-neutral.
import type { Ports } from "../types.ts";
import type { ArcFn, ArcType } from "../arc.ts";
import type { DecompileCtx } from "../decompile.ts";
import type { Observed } from "../engine.ts";
import type { Edge } from "../levels.ts";
import { tsLang } from "./ts.ts";
import { goLang } from "./go.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
/** A call with literal arguments, where it is: `<file>:<1-based line>`. */
export interface Call { args: Json[]; at: string }
/** An exported function or public method as read from the code. inputs: what its parameter types allow. tests: the test
 *  files that use it, sorted. cls: an instance method's receiver: `calls` build one (constructor arguments), `bare`
 *  when one can be built from nothing. */
export interface FoundFn { fn: ArcFn; inputs: Json[][] | null; tests: string[]; calls: Call[]; cls?: { name: string; bare: boolean; calls: Call[] } }
export interface ReadModule { types: ArcType[]; found: FoundFn[]; skipped: Record<string, string> }
/** modules: per source file. instrumented: per source file, the text that records arguments while tests run (--run-tests). */
export interface Read { modules: Map<string, ReadModule>; instrumented: Map<string, string> }
/** Runs one function on inputs, a sandbox kept open across calls until close. */
export interface Runner {
  observe(file: string, fn: Pick<ArcFn, "name" | "static">, inputs: Json[][]): Promise<Observed[] | { error: string }>;
  close(): Promise<void>;
}
/** A function in a file's text: its body (braces included) at [start, end), the indent of the line it starts on, and
 *  its whole text for a prompt. */
export interface Located { start: number; end: number; indent: string; code: string }

export interface Lang {
  /** The files this language reads. */
  code: RegExp;
  isTest(rel: string): boolean;
  /** The language's name in a prompt. */
  label(file: string): string;
  /** The function forms locate finds, for a refusal. */
  forms: string;
  /** One indent step in a body. */
  indent: string;
  /** The project's source files (and its test files, for uses) into modules. */
  read(ctx: DecompileCtx, sources: string[], tests: string[]): Promise<Read>;
  /** A sandbox staging `texts` (the source tree as ports.fs reads it). */
  open(ctx: DecompileCtx, texts: Map<string, string>): Runner;
  /** Runs one test file (--run-tests); env: added to its environment. why: a reason for a failure beyond "it fails". */
  runTest(ctx: DecompileCtx, file: string, env?: Record<string, string>): Promise<{ ok: boolean; why?: string }>;
  locate(ctx: Omit<DecompileCtx, "dirs">, file: string, text: string, name: string): Promise<Located | undefined>;
  /** The reply is not a body: it repeats the declaration. */
  notBody(file: string, body: string, name: string): boolean;
  /** Syntax and type errors `after` adds to `file`. */
  problems(ctx: Omit<DecompileCtx, "dirs">, file: string, after: string): Promise<string[]>;
  /** Imports between `files` and to packages. */
  imports(ports: Ports, files: Map<string, string>): Promise<Edge[]>;
}

export const LANGS: Lang[] = [tsLang, goLang];
export const langOf = (file: string): Lang | undefined => LANGS.find((l) => l.code.test(file));
