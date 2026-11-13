// `openarc mcp`: OpenArc's commands as MCP tools over stdio, so any agent or plugin can call them without a skill or
// parsing terminal text. Hand-written, no SDK: newline-delimited JSON-RPC 2.0, one message per line, stdout carries
// protocol messages only. Dual-era: answers the legacy `initialize` handshake (2025-11-25 and earlier) and modern
// per-request `_meta` (2026-07-28, `server/discover`). Each call runs this same OpenArc CLI in a child process.
// Adding a tool is one row in TOOLS.
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

type Input = Record<string, unknown>;
type Prop = { type: "string"; description: string } | { type: "array"; items: { type: "string" }; description: string };
type Schema = { type: "object"; properties: Record<string, Prop>; required?: string[]; additionalProperties: false };
/** One tool: the CLI arguments it runs, and optionally what goes to the child's stdin. Throwing reports the message
 *  to the caller as a tool error. */
export type Tool = { name: string; description: string; inputSchema: Schema; argv: (i: Input) => string[]; stdin?: (i: Input) => string };

const str = (description: string): Prop => ({ type: "string", description });
const strs = (description: string): Prop => ({ type: "array", items: { type: "string" }, description });
const obj = (properties: Record<string, Prop> = {}, required: string[] = []): Schema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
/** A value passed as a positional argument: never a flag. */
const pos = (v: unknown): string => {
  const s = String(v);
  if (!s || s.startsWith("-")) throw new Error(`not a valid argument: ${JSON.stringify(s)}`);
  return s;
};
const dirs = (i: Input) => ((i.dirs as string[] | undefined) ?? []).map(pos);
const DIRS = { dirs: strs("source folders relative to the project (default src)") };
const ID = obj({ id: str("region id") }, ["id"]);

export const TOOLS: Tool[] = [
  { name: "status", description: "What backs each goal and part: decompiled functions per status. Start here.", inputSchema: obj({ part: str("only this part"), goal: str("only this goal") }), argv: (i) => ["status", "--json", ...(i.part ? ["--part", pos(i.part)] : []), ...(i.goal ? ["--goal", pos(i.goal)] : [])] },
  { name: "decompile_report", description: "Per-module report of the last decompile.", inputSchema: obj(), argv: () => ["decompile", "--report"] }, // text: --json dumps the whole state
  { name: "decompile_todo", description: "Functions whose spec still lacks an intent (last decompile).", inputSchema: obj(), argv: () => ["decompile", "--todo", "--json"] },
  { name: "decompile_check", description: "Run the .arc spec lines against the code; error when behaviour changed. Use after editing code.", inputSchema: obj(DIRS), argv: (i) => ["decompile", "--check", "--json", ...dirs(i)] },
  { name: "arch", description: "Derive or extend arc/architecture.arc from the imports (writes it).", inputSchema: obj(DIRS), argv: (i) => ["arch", "--json", ...dirs(i)] },
  { name: "arch_check", description: "Check arc/architecture.arc against the real imports.", inputSchema: obj(DIRS), argv: (i) => ["arch", "--check", "--json", ...dirs(i)] },
  { name: "concept", description: "Write or reprint arc/concept.arc in canonical form (writes it).", inputSchema: obj(), argv: () => ["concept", "--json"] },
  { name: "concept_check", description: "Check every goal in arc/concept.arc traces to architecture parts.", inputSchema: obj(), argv: () => ["concept", "--check", "--json"] },
  { name: "inspect", description: "One region's spec, state, ownership and provenance.", inputSchema: ID, argv: (i) => ["inspect", pos(i.id)] },
  {
    name: "guard", description: "Before editing a file: would the edit touch compiler-owned code? Give old_string for an edit, content for a whole-file write.",
    inputSchema: obj({ file: str("file to edit"), old_string: str("text the edit replaces"), content: str("the whole new file") }, ["file"]),
    argv: (i) => {
      if (i.old_string === undefined && i.content === undefined) throw new Error("give old_string or content: a path alone has nothing to check");
      return ["guard", "--hook"];
    },
    stdin: (i) => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: i.file, old_string: i.old_string, content: i.content } }),
  },
  { name: "prompt", description: "Host-agent mode: the prompt for a pending or stale region. Write the body yourself, then call accept.", inputSchema: ID, argv: (i) => ["prompt", pos(i.id), "--json"] },
  { name: "accept", description: "Host-agent mode: verify the body you wrote for a region; commits it if it passes, else lists the problems.", inputSchema: obj({ id: str("region id"), body: str("the function body, as prompt asks") }, ["id", "body"]), argv: (i) => ["accept", pos(i.id), "--json"], stdin: (i) => String(i.body) },
  { name: "arc_status", description: "Which functions the code does not meet their .arc spec (stale), with the failing example or rule.", inputSchema: obj({ name: str("module or module.fn") }), argv: (i) => ["arc", "status", ...(i.name === undefined ? [] : [pos(i.name)]), "--json"] },
  { name: "arc_prompt", description: "To change a function from its .arc spec: its spec, current code and failing examples. Write the body, then call arc_accept.", inputSchema: obj({ name: str("module.fn") }, ["name"]), argv: (i) => ["arc", "prompt", pos(i.name), "--json"] },
  { name: "arc_accept", description: "Verify your body against the function's examples and rules; replaces the body if all pass, else changes nothing.", inputSchema: obj({ name: str("module.fn"), body: str("the function body: statements only, no signature") }, ["name", "body"]), argv: (i) => ["arc", "accept", pos(i.name), "--json"], stdin: (i) => String(i.body) },
];

const MODERN = "2026-07-28";
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]; // initialize-era, newest first
const INFO = { name: "openarc", version: "0.0.0" };
const TIMEOUT_MS = 120_000; // ponytail: one limit for every tool; a per-row timeout when a slow one needs more
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const withRoot = (s: Schema): Schema => ({ ...s, properties: { ...s.properties, root: str("project folder (default: where the server runs)") } });

/** Why `a` doesn't fit the schema, or null. Only the shapes rows use: strings and arrays of strings. */
function invalid(s: Schema, a: unknown): string | null {
  if (!isObj(a)) return "arguments must be an object";
  for (const [k, v] of Object.entries(a)) {
    const p = s.properties[k];
    if (!p) return `unknown argument ${k}`;
    if (p.type === "string" ? typeof v !== "string" : !Array.isArray(v) || v.some((x) => typeof x !== "string")) return `${k} must be ${p.type === "string" ? "a string" : "an array of strings"}`;
  }
  const missing = (s.required ?? []).find((k) => !(k in a));
  return missing ? `missing ${missing}` : null;
}

/** Serve MCP on stdin/stdout until stdin closes. `cli` runs OpenArc (node, its flags, main.ts); `cwd` is the default root. */
export function serveMcp(cli: string[], cwd: string): Promise<number> {
  const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
  const running = new Map<string | number, ChildProcess>(), cancelled = new Set<string | number>();
  process.stdout.on("error", () => process.exit(0)); // the client went away

  const call = (tool: Tool, args: unknown, id: string | number): Promise<object> => {
    const text = (t: string, isError: boolean) => ({ content: [{ type: "text", text: t }], isError });
    let argv: string[], input: string | undefined, dir: string;
    try {
      const why = invalid(withRoot(tool.inputSchema), args ?? {});
      if (why) throw new Error(why);
      const a = (args ?? {}) as Input;
      dir = resolve(cwd, typeof a.root === "string" ? a.root : ".");
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`root ${dir} is not a folder`);
      argv = tool.argv(a);
      input = tool.stdin?.(a);
    } catch (e) {
      return Promise.resolve(text((e as Error).message, true));
    }
    return new Promise((done) => {
      const c = spawn(cli[0]!, [...cli.slice(1), ...argv], { cwd: dir, timeout: TIMEOUT_MS, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      running.set(id, c);
      let out = "", err = "";
      c.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
      c.stderr!.setEncoding("utf8").on("data", (d: string) => (err += d));
      c.on("error", (e) => (err += e.message));
      c.stdin?.on("error", () => {}); // a child that exits without reading its stdin
      c.stdin?.end(input);
      c.on("close", (code, signal) => {
        running.delete(id);
        if (code === 0) return done(text(out.trim() || "ok", false));
        const end = signal ? `killed by ${signal} (the limit is ${TIMEOUT_MS / 1000}s)` : `exit ${code}`;
        done(text([out.trim(), err.trim(), end].filter(Boolean).join("\n"), true));
      });
    });
  };

  const handle = async (line: string) => {
    let m: unknown;
    try { m = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const id = isObj(m) && (typeof m.id === "string" || typeof m.id === "number") ? m.id : null;
    if (!isObj(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string" || ("id" in m && id === null)) return send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
    const params: Input = isObj(m.params) ? m.params : {};
    if (id === null) { // a notification: never answered
      const r = params.requestId as string | number;
      if (m.method === "notifications/cancelled" && running.has(r)) cancelled.add(r), running.get(r)!.kill();
      return;
    }
    const meta = isObj(params._meta) ? params._meta : {}, version = meta["io.modelcontextprotocol/protocolVersion"];
    const modern = version !== undefined;
    const reply = (result: object) => send({ jsonrpc: "2.0", id, result: modern || m.method === "server/discover" ? { resultType: "complete", ...result } : result });
    const fail = (code: number, message: string, data?: unknown) => send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
    if (modern && m.method !== "initialize") {
      if (version !== MODERN && !LEGACY.includes(version)) return fail(-32022, "Unsupported protocol version", { supported: [MODERN, ...LEGACY], requested: version });
      if (version === MODERN && !isObj(meta["io.modelcontextprotocol/clientCapabilities"])) return fail(-32602, "Invalid params: _meta needs io.modelcontextprotocol/clientCapabilities");
    }
    switch (m.method) {
      case "initialize": return reply({ protocolVersion: LEGACY.includes(params.protocolVersion as string) ? params.protocolVersion : LEGACY[0], capabilities: { tools: {} }, serverInfo: INFO });
      case "server/discover": return reply({ supportedVersions: [MODERN, ...LEGACY], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": INFO } });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: withRoot(t.inputSchema) })) });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return fail(-32602, `Unknown tool: ${String(params.name)}`);
        const result = await call(tool, params.arguments, id);
        return cancelled.delete(id) ? undefined : reply(result);
      }
      default: return fail(-32601, `Method not found: ${m.method}`);
    }
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => void (line.trim() && handle(line)));
  return new Promise((done) => rl.on("close", () => {
    for (const c of running.values()) c.kill();
    done(0);
  }));
}
