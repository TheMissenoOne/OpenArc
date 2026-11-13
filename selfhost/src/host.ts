// Host-agent mode (docs/wiki/Host-Agent-Mode.md): the coding agent that is already running writes a region's body.
// `openarc prompt` hands it the context, `openarc accept` puts its body through compile's own pipeline, and
// `openarc guard` stops hand edits of compiler-owned code. Nothing here calls a model. Hand-written.
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ImportDecl, Ports } from "./types.ts";
import * as engine from "./engine.ts";
import { renderTemplate } from "./model.ts";
import { CODE_PROMPT_TEMPLATE, CODE_SYSTEM } from "./output-format.ts";
import { SKETCH_CODE_PROMPT_TEMPLATE, SKETCH_CODE_SYSTEM } from "./sketch.ts";
import { SHEET_FILE, parseSheet } from "./sheet.ts";
import { scanMarkers } from "./implicit.ts";
import { buildRegionTree } from "./markers.ts";

/** Why host mode won't write region `id` (null: it will). `sheet` is openarc.spec.md's text, for `**Hold**`. */
export function hostRefusal(p: engine.Project, id: string, sheet: string | null): string | null {
  const r = p.regions.find((x) => x.id === id);
  if (!r) return `no region ${id}`;
  // ponytail: one function region without nested blocks; a block is verified through its function, so compile those
  if (r.kind !== "function" || r.childSpans.length) return `${id}: host mode writes function regions without blocks; use \`openarc compile ${id}\``;
  if (r.state === "developer") return `${id} is developer-owned: edit it by hand, or \`openarc release ${id}\` to hand it to the compiler`;
  if (r.state === "conflicted") return `${id} is conflicted: settle it first with \`openarc resolve ${id} --keep|--regen\``;
  if (sheet !== null && parseSheet(sheet).sheet.regions.some((s) => s.id === id && s.hold)) return `${id} is held (**Hold** in ${SHEET_FILE}): remove the hold first`;
  return null;
}

/** What a model would be sent for region `id` on attempt 1 at its initial context level, in the "code" output format
 *  (accept reads code, whatever the backend's format): engine.buildContext and the code prompt templates. */
export function hostPrompt(p: engine.Project, id: string): { id: string; file: string; signature: string; outputFormat: "code"; system: string; prompt: string; instruction: string } {
  const r = p.regions.find((x) => x.id === id)!;
  const backend = { ...engine.backendFor(p, id, 0), outputFormat: "code" as const };
  const context = engine.buildContext(p, r, engine.initialLevel(p, r), backend);
  const sk = !!r.spec.sketch;
  const rendered = renderTemplate(sk ? SKETCH_CODE_PROMPT_TEMPLATE : CODE_PROMPT_TEMPLATE, { context, repair: engine.repairText(null) });
  if (!rendered.ok) throw new Error(`prompt template is missing ${rendered.missing.join(", ")}`);
  const what = sk ? "the sketch's statements with every hole filled" : "the function BODY only: statements, no signature";
  return {
    id, file: r.file, signature: r.spec.signature, outputFormat: "code", system: sk ? SKETCH_CODE_SYSTEM : CODE_SYSTEM, prompt: rendered.text,
    instruction: `Pipe your reply to \`openarc accept ${id}\`: ${what}, no markers, no code fences; import lines at the top if needed.`,
  };
}

const FAILED = ".openarc/failed.json";
const NO_MODEL = () => Promise.reject(new Error("host mode: no model call"));
const AGENT_CLIS = new Set(["claude", "codex", "opencode"]); // backends.cliRequest's argv[0]

/** Ports for one `accept` through compile.run (ids [id]): the body is served as the region's cache entry, so it takes
 *  the cache-hit path, which is a model reply's path after parsing (unwrap, marker stripping, static rules, splice,
 *  tsc, sandbox, stage, manifest, commit). Around it: one attempt and no fallback backend (config), no model request at
 *  all (http POST and agent CLIs refuse), a rejection is not remembered in failed.json and its attempt record becomes
 *  `seen.problems` instead of a file, and the committed provenance names backend "host", model "host-agent". */
export function hostPorts(ports: Ports, id: string, cachePath: string, reply: { body: string; imports: ImportDecl[] }, seen: { served: boolean; problems: string[] }): Ports {
  const fs = ports.fs;
  return {
    ...ports,
    usage: undefined, // no request, nothing to count
    log: () => {}, // compile's progress lines would say "cache hit": the problems are reported instead
    http: { get: (url) => ports.http.get(url), postJson: NO_MODEL }, // GET: Ollama's /api/tags for the fingerprint, no model load
    proc: { run: (argv, t, o) => (AGENT_CLIS.has(argv[0]!) ? NO_MODEL() : ports.proc.run(argv, t, o)) },
    fs: {
      ...fs,
      async read(rel) {
        if (rel === cachePath) return (seen.served = true), JSON.stringify(reply);
        const text = await fs.read(rel);
        return rel === "openarc.config.json" && text !== null ? oneAttempt(text) : text;
      },
      async write(rel, data) {
        if (rel === FAILED) return; // the agent fixes and retries: a later compile must not skip the region
        const a = /^\.openarc\/attempts\/([^/]+)\//.exec(rel);
        if (a) return void seen.problems.push(...problemsOf(data, a[1] === id ? "" : `${a[1]}: `));
        await fs.write(rel, seen.served && /^\.openarc\/txn\/[^/]+\/stage\/\d+$/.test(rel) ? relabel(data, id) : data);
      },
      async remove(rel) {
        if (!rel.startsWith(".openarc/attempts/")) await fs.remove(rel); // saveAttempt's pruning: nothing was written
      },
    },
  };
}

/** maxAttempts and fallbackBackend are not in any fingerprint, so this changes no region's freshness. */
function oneAttempt(text: string): string {
  try {
    const c = JSON.parse(text) as { compilation?: Record<string, unknown> };
    const { fallbackBackend: _f, ...rest } = c.compilation ?? {};
    return JSON.stringify({ ...c, compilation: { ...rest, maxAttempts: 1 } });
  } catch {
    return text; // invalid JSON: parseConfig reports it
  }
}
function problemsOf(record: string, prefix: string): string[] {
  try {
    return ((JSON.parse(record) as { problems?: string[] }).problems ?? []).map((x) => prefix + x);
  } catch {
    return [];
  }
}
/** The staged manifest (the last staged file) with region `id`'s provenance naming the host agent; other files as is. */
function relabel(text: string, id: string): string {
  try {
    const m = JSON.parse(text) as engine.Manifest;
    const prov = m.schema === 1 ? m.regions?.[id]?.provenance : undefined;
    if (!prov) return text;
    const { digest: _d, tokens: _t, sampling: _s, ...rest } = prov;
    m.regions[id]!.provenance = { ...rest, source: "host", backend: "host", model: "host-agent" };
    return JSON.stringify(m, null, 2) + "\n";
  } catch {
    return text; // a source file
  }
}

// ── guard ────────────────────────────────────────────────────────────────────

/** What an agent's file tool would do: Claude Code's Edit (old_string), MultiEdit (edits) and Write (content). */
export interface EditInput { old_string?: unknown; content?: unknown; edits?: unknown }

const MESSAGE = (id: string) =>
  `${id} is compiler-owned: OpenArc writes it. Edit its spec and run \`openarc compile ${id}\` (or \`openarc prompt ${id}\` and \`openarc accept ${id}\`), or \`openarc freeze ${id}\` to own it.`;

/** Region id -> [start, end) offsets of its begin marker line through its end marker line, for every region. */
function spans(text: string): Map<string, [number, number]> {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const out = new Map<string, [number, number]>();
  const walk = (ns: ReturnType<typeof buildRegionTree>["roots"]): void =>
    ns.forEach((n) => (out.set(n.id, [starts[n.beginLine - 1]!, starts[n.endLine] ?? text.length]), walk(n.children)));
  walk(buildRegionTree(scanMarkers(text).markers).roots);
  return out;
}
const bodyOf = (text: string, s: [number, number] | undefined) => (s ? text.slice(s[0], s[1]).replace(/\r?\n$/, "") : null);

/** The guard's decision for one edit of a file: null, or why it would change a compiler-owned region (`owned` ids).
 *  Edit/MultiEdit: an occurrence of an old_string overlaps a region's markers or body. Write: a region's markers or
 *  body differ in the new content. ponytail: MultiEdit's later old_strings are matched against the file as it is, not
 *  as the earlier edits leave it. */
export function guardEdit(fileText: string, owned: string[], input: EditInput): string | null {
  const before = spans(fileText);
  if (typeof input.content === "string") {
    const after = spans(input.content);
    const id = owned.find((x) => before.has(x) && bodyOf(fileText, before.get(x)) !== bodyOf(input.content as string, after.get(x)));
    return id ? MESSAGE(id) : null;
  }
  const olds = [input.old_string, ...(Array.isArray(input.edits) ? input.edits.map((e) => (e as EditInput | null)?.old_string) : [])].filter((s): s is string => typeof s === "string" && s !== "");
  for (const old of olds)
    for (let i = fileText.indexOf(old); i >= 0; i = fileText.indexOf(old, i + 1))
      for (const id of owned) {
        const s = before.get(id);
        if (s && i < s[1] && i + old.length > s[0]) return MESSAGE(id);
      }
  return null;
}

/** A Codex apply_patch text as one EditInput per file: an Update hunk is an Edit (its context and `-` lines are the
 *  old_string), an Add is a Write, a Delete or a Move writes "" over the old path. ponytail: a hunk is matched by text,
 *  not by its @@ position. */
export function patchInputs(patch: string): Map<string, EditInput> {
  const out = new Map<string, EditInput>();
  let file = "";
  let mode = "";
  let hunk: string[] = [];
  const flush = () => {
    if (mode === "Update" && hunk.length) (out.get(file)!.edits as EditInput[]).push({ old_string: hunk.join("\n") });
    hunk = [];
  };
  for (const line of patch.replace(/\r/g, "").split("\n")) {
    const head = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (head || line.startsWith("*** ") || line.startsWith("@@")) flush();
    if (head) {
      [file, mode] = [head[2]!.trim(), head[1]!];
      out.set(file, mode === "Update" ? { edits: [] } : { content: "" });
    } else if (line.startsWith("*** Move to: ") && mode === "Update") {
      out.set(file, { content: "" });
      mode = "Move";
    } else if (mode === "Add" && line.startsWith("+")) out.get(file)!.content += line.slice(1) + "\n";
    else if (mode === "Update" && (line === "" || line.startsWith(" ") || line.startsWith("-"))) hunk.push(line.slice(1)); // "": a blank context line
  }
  flush();
  return out;
}

/** `openarc guard --hook`: a PreToolUse event (Claude Code's shape, `{tool_name, tool_input}`) -> the reason to block
 *  it, or null. Reads the manifest and the edited files only; anything it doesn't understand passes. A Codex
 *  apply_patch is recognised by its text. ponytail: paths are compared as spelled (resolved, not realpath'd). */
export function guardHook(root: string, raw: string): string | null {
  let input: Record<string, unknown>;
  let manifest: engine.Manifest;
  try {
    input = (JSON.parse(raw) as { tool_input?: Record<string, unknown> }).tool_input!;
    if (typeof input !== "object" || input === null) return null;
    manifest = JSON.parse(readFileSync(resolve(root, ".openarc/manifest.json"), "utf8")) as engine.Manifest;
  } catch {
    return null;
  }
  const patch = Object.values(input).find((v): v is string => typeof v === "string" && v.trimStart().startsWith("*** Begin Patch"));
  const targets: [string, EditInput][] = patch !== undefined ? [...patchInputs(patch)] : typeof input.file_path === "string" ? [[input.file_path, input]] : [];
  for (const [path, edit] of targets) {
    const abs = resolve(path);
    const rel = relative(root, abs).split(sep).join("/");
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const owned = Object.entries(manifest.regions ?? {}).filter(([, m]) => m.ownership === "compiler" && m.file === rel).map(([id]) => id);
    if (!owned.length) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const why = guardEdit(text, owned, edit);
    if (why) return why;
  }
  return null;
}
