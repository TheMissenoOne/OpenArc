// `openarc mcp`: the real server over stdio in a temp project: handshake, tools, a read-only call, guard, a failing
// call, a malformed line, an unknown method, and the modern (per-request _meta) era.
// Run: node --no-warnings tests/mcp.check.ts
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const dir = mkdtempSync(join(resolve(".."), ".mcp-check-"));
const other = join(dir, "other");
const server = spawn(process.execPath, ["--no-warnings", resolve("src/main.ts"), "mcp"], { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map<unknown, (m: any) => void>();
createInterface({ input: server.stdout! }).on("line", (l) => {
  const m = JSON.parse(l); // every stdout line must be JSON
  assert.strictEqual(m.jsonrpc, "2.0");
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
});
const raw = (line: string, id: unknown) => new Promise<any>((done) => (waiting.set(id, done), server.stdin!.write(line + "\n")));
let n = 0;
const rpc = (method: string, params?: object) => { const id = ++n; return raw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }), id); };
const call = async (name: string, args: object = {}) => (await rpc("tools/call", { name, arguments: args })).result as { content: { type: string; text: string }[]; isError: boolean };

try {
  mkdirSync(join(dir, "src"));
  mkdirSync(join(other, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(other, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(dir, "src/a.ts"), 'import { b } from "./b.ts";\nexport const a = () => b();\n');
  writeFileSync(join(dir, "src/b.ts"), "export const b = () => 1;\n");
  const owned = "const a = 1;\n// @openarc:begin m.f\nexport function f() {\n  return 1;\n}\n// @openarc:end m.f\n";
  writeFileSync(join(other, "src/m.ts"), owned);
  mkdirSync(join(other, ".openarc"));
  writeFileSync(join(other, ".openarc/manifest.json"), JSON.stringify({ schema: 1, regions: { "m.f": { ownership: "compiler", file: "src/m.ts" } } }));

  // legacy handshake: the client's version back when supported, else the newest legacy one
  let r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } });
  assert.deepStrictEqual(r.result, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openarc", version: "0.0.0" } });
  server.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); // no reply
  assert.strictEqual((await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {} })).result.protocolVersion, "2025-11-25");
  assert.deepStrictEqual((await rpc("ping")).result, {});

  const tools = (await rpc("tools/list")).result.tools as { name: string; description: string; inputSchema: { properties: object } }[];
  for (const t of ["status", "decompile_report", "decompile_todo", "decompile_check", "arch", "arch_check", "concept", "concept_check", "inspect", "guard", "prompt", "accept", "pdl_status", "pdl_show", "pdl_check", "pdl_sync"]) assert.ok(tools.some((x) => x.name === t), t);
  assert.ok(tools.every((t) => "root" in t.inputSchema.properties && t.description.length < 140), "every tool takes root; descriptions stay short");
  assert.ok(!tools.some((t) => t.name === "setup" || t.name === "decompile"));

  // read-only (and arch writes its file), then the check against it
  let c = await call("arch");
  assert.strictEqual(c.isError, false, c.content[0]!.text);
  assert.ok(JSON.parse(c.content[0]!.text).modules === 2);
  c = await call("arch_check");
  assert.strictEqual(c.isError, false, c.content[0]!.text);
  // a failing command: isError, stderr included
  c = await call("decompile_report");
  assert.strictEqual(c.isError, true);
  assert.match(c.content[0]!.text, /nothing decompiled yet[\s\S]*exit 1$/);
  // bad arguments are tool errors, not protocol errors
  for (const args of [{ id: "--fresh" }, {}, { id: 3 }, { id: "x", extra: "y" }]) assert.strictEqual((await call("inspect", args)).isError, true, JSON.stringify(args));
  assert.match((await call("status", { root: "nowhere" })).content[0]!.text, /is not a folder/);

  // guard, in another project through root: an edit inside the compiler-owned region is refused, one outside passes
  c = await call("guard", { root: other, file: "src/m.ts", old_string: "return 1;" });
  assert.strictEqual(c.isError, true);
  assert.match(c.content[0]!.text, /m\.f is compiler-owned/);
  c = await call("guard", { root: other, file: "src/m.ts", old_string: "const a = 1;\n" });
  assert.deepStrictEqual(c, { content: [{ type: "text", text: "ok" }], isError: false });
  assert.strictEqual((await call("guard", { root: other, file: "src/m.ts" })).isError, true, "a path alone checks nothing");
  assert.strictEqual(readFileSync(join(other, "src/m.ts"), "utf8"), owned);

  // the design language: status, show, check, sync on a one-feature design over src/b.ts
  mkdirSync(join(dir, "arc/features"), { recursive: true });
  writeFileSync(join(dir, "arc/features/b.arc"), 'feature B {\n  returns one;\n  source "src/b.ts";\n\n  b() { gives back 1; }\n}\n');
  const pdl = async (name: string, args: object = {}) => { const c = await call(name, args); assert.strictEqual(c.isError, false, c.content[0]!.text); return c.content[0]!.text; };
  assert.deepStrictEqual(JSON.parse(await pdl("pdl_status")).blocks.map((b: { id: string; status: string }) => `${b.id} ${b.status}`), ["B new", "B.b new"]);
  assert.strictEqual(JSON.parse(await pdl("pdl_status", { id: "B.b" })).summary.blocks, 1);
  const shown = JSON.parse(await pdl("pdl_show", { id: "B.b" }));
  assert.deepStrictEqual([shown.text, shown.purpose, shown.source], ["b() { gives back 1; }", ["returns one"], ["src/b.ts"]]);
  assert.match((await call("pdl_show", { id: "B.nope" })).content[0]!.text, /no block B\.nope[\s\S]*exit 1$/);
  assert.strictEqual(JSON.parse(await pdl("pdl_check")).ok, true);
  assert.strictEqual((await call("pdl_sync", { ids: [] })).isError, true, "sync names its blocks");
  assert.strictEqual((await call("pdl_sync", { ids: ["--all"] })).isError, true);
  assert.match(await pdl("pdl_sync", { ids: ["B", "B.b"] }), /^synced 2 blocks/);
  assert.strictEqual(JSON.parse(await pdl("pdl_status")).summary.inStep, 2);
  writeFileSync(join(dir, "arc/features/broken.arc"), "feature C {\n");
  c = await call("pdl_check");
  assert.strictEqual(c.isError, true);
  assert.strictEqual(JSON.parse(c.content[0]!.text.split("\n")[0]!).ok, false, "the JSON report, then the exit");
  rmSync(join(dir, "arc/features/broken.arc"));

  // protocol errors
  r = await raw("{ not json", null);
  assert.strictEqual(r.error.code, -32700);
  r = await raw(JSON.stringify([{ jsonrpc: "2.0", id: 99, method: "ping" }]), null);
  assert.strictEqual(r.error.code, -32600, "no batches");
  assert.strictEqual((await rpc("resources/list")).error.code, -32601);
  assert.strictEqual((await rpc("tools/call", { name: "setup", arguments: {} })).error.code, -32602);

  // modern era: per-request _meta, resultType on results
  const meta = (v: string) => ({ _meta: { "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientCapabilities": {} } });
  r = await rpc("server/discover", meta("2026-07-28"));
  assert.strictEqual(r.result.resultType, "complete");
  assert.deepStrictEqual(r.result.capabilities, { tools: {} });
  assert.strictEqual(r.result.supportedVersions[0], "2026-07-28");
  r = await rpc("tools/list", meta("2026-07-28"));
  assert.strictEqual(r.result.resultType, "complete");
  r = await rpc("tools/list", meta("1900-01-01"));
  assert.strictEqual(r.error.code, -32022);
  assert.strictEqual(r.error.data.requested, "1900-01-01");
  assert.strictEqual((await rpc("ping", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } })).error.code, -32602, "clientCapabilities is required");

  // closing stdin ends the server
  server.stdin!.end();
  const code = await new Promise((done) => server.on("exit", done));
  assert.strictEqual(code, 0);
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
console.log("mcp.check ok");
