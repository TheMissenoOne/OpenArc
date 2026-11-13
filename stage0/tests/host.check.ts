// Host-agent mode end to end: `openarc prompt`, `accept` and `guard` on the real CLI, a temp project, and a stub model
// server that must never be called. Plus guardEdit and patchInputs, pure.
// Run: node --no-warnings tests/host.check.ts
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { guardEdit, patchInputs } from "../src/host.ts";
import { renderSheet } from "../src/sheet.ts";

// ── pure: the guard's decision
{
  const text = "const a = 1;\n// @openarc:begin m.f\nexport function f() {\n  return 1;\n}\n// @openarc:end m.f\nconst b = 2;\n";
  const blocked = (input: object, owned = ["m.f"]) => guardEdit(text, owned, input);
  assert.match(blocked({ old_string: "return 1;" })!, /m\.f is compiler-owned/);
  assert.ok(blocked({ old_string: "// @openarc:end m.f" }), "a marker line is the region's");
  assert.ok(blocked({ old_string: "end m.f\nconst b" }), "an occurrence reaching into the region");
  assert.strictEqual(blocked({ old_string: "const b = 2;" }), null);
  assert.strictEqual(blocked({ old_string: "const a = 1;\n" }), null, "ending where the begin marker's line starts");
  assert.strictEqual(blocked({ old_string: "return 1;" }, []), null, "not compiler-owned");
  assert.strictEqual(blocked({ old_string: "nowhere" }), null);
  assert.ok(blocked({ edits: [{ old_string: "const b" }, { old_string: "return 1" }] }), "MultiEdit");
  assert.strictEqual(blocked({ content: text.replace("const b = 2;", "const b = 3;") }), null, "a Write keeping the region");
  assert.ok(blocked({ content: text.replace("return 1;", "return 2;") }), "a Write changing it");
  assert.ok(blocked({ content: "const a = 1;\n" }), "a Write dropping it");
  const p = patchInputs("*** Begin Patch\n*** Update File: src/m.ts\n@@\n const a = 1;\n-x\n+y\n*** Add File: src/n.ts\n+hi\n*** Delete File: src/o.ts\n*** End Patch\n");
  assert.deepStrictEqual([...p], [["src/m.ts", { edits: [{ old_string: "const a = 1;\nx" }] }], ["src/n.ts", { content: "hi\n" }], ["src/o.ts", { content: "" }]]);
}

if (process.platform === "win32") {
  console.log("host.check ok (pure checks only on Windows)");
  process.exit(0);
}
const MAIN = resolve("src/main.ts");
const dir = mkdtempSync(join(resolve(".."), ".host-check-"));
let calls = 0;
const server = createServer((req, res) => {
  calls++;
  req.resume();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "return 0;" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const oa = (args: string[], stdin = "") => new Promise<{ code: number | null; out: string; err: string }>((done) => {
  const c = spawn(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  c.stdout.on("data", (b) => (out += b));
  c.stderr.on("data", (b) => (err += b));
  c.on("close", (code) => done({ code, out, err }));
  c.stdin.end(stdin);
});
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const write = (f: string, t: string) => writeFileSync(join(dir, f), t);
const manifest = () => JSON.parse(read(".openarc/manifest.json")) as { regions: Record<string, { ownership: string; provenance: Record<string, unknown> }> };
const hook = (tool_name: string, tool_input: object) => oa(["guard", "--hook"], JSON.stringify({ tool_name, tool_input }));
const ID = "m.inc";
try {
  mkdirSync(join(dir, "src"));
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
  write("package.json", '{"name":"host","version":"1.0.0","type":"module","private":true}');
  write("tsconfig.json", '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noEmit":true,"allowImportingTsExtensions":true,"skipLibCheck":true},"include":["src"]}');
  const stub = { provider: "local", baseUrl: `http://127.0.0.1:${port}/v1`, model: "stub", maxContextTokens: 8192 };
  // two attempts and a fallback backend: accept must still make exactly one attempt and no request
  write("openarc.config.json", JSON.stringify({ version: 1, backends: { local: stub, fb: { ...stub, model: "fb" } }, compilation: { defaultBackend: "local", fallbackBackend: "fb", maxAttempts: 3, batch: "off" }, sandbox: { isolation: "unsafe-none" } }));
  const SRC0 = 'import * as arc from "open-arc";\n\n/** Adds one to n. */\nexport function inc(n: number): number {\n  return arc.todo();\n}\n\n/** Twice n. */\nexport function twice(n: number): number {\n  return n * 2;\n}\n\narc.configure(inc, { examples: [{ args: [1], expected: 2 }, { args: [0], expected: 1 }, { args: [-1], expected: 0 }] });\n';
  write("src/m.ts", SRC0);
  const init = await oa(["init"]);
  assert.strictEqual(init.code, 0, init.out + init.err);
  const ex = await oa(["extract", "src/m.ts", "--function", "twice"]); // a developer-owned region
  assert.strictEqual(ex.code, 0, ex.out + ex.err);
  const SRC = read("src/m.ts");

  // prompt: the instruction, then the code prompt with the region's context
  let r = await oa(["prompt", ID]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.out.startsWith(`Pipe your reply to \`openarc accept ${ID}\`: the function BODY only`), r.out);
  assert.ok(r.out.includes("Adds one to n.") && r.out.includes("Implement exactly one OpenArc region"), r.out);
  r = await oa(["prompt", ID, "--json"]);
  const pj = JSON.parse(r.out) as Record<string, string>;
  assert.deepStrictEqual(Object.keys(pj), ["id", "file", "signature", "outputFormat", "system", "prompt"]);
  assert.deepStrictEqual([pj.id, pj.file, pj.outputFormat], [ID, "src/m.ts", "code"]);
  assert.ok(pj.prompt!.includes("Adds one to n."));
  r = await oa(["prompt", "m.nope"]);
  assert.strictEqual(r.code, 1);
  assert.ok(r.err.includes("no region m.nope"));
  r = await oa(["prompt", "m.twice"]);
  assert.strictEqual(r.code, 1);
  assert.ok(r.err.includes("m.twice is developer-owned"), r.err);

  // held in the sheet: refused by both
  write("openarc.spec.md", renderSheet({ regions: [{ id: ID, file: "src/m.ts", signature: "(n: number): number", intent: "Adds one to n.", examples: [], hold: true, notes: [], suggestions: [] }], notAdopted: [] }));
  for (const cmd of ["prompt", "accept"]) {
    r = await oa([cmd, ID], "return n + 1;");
    assert.strictEqual(r.code, 1, cmd);
    assert.ok(r.err.includes(`${ID} is held`), r.err);
  }
  rmSync(join(dir, "openarc.spec.md"));
  r = await oa(["accept", "m.twice"], "return n * 2;");
  assert.strictEqual(r.code, 1);
  assert.ok(r.err.includes("developer-owned"));

  // a body failing an example: the problem line, nothing on disk, not remembered as failed
  r = await oa(["accept", ID], "return n + 2;");
  assert.strictEqual(r.code, 1, r.out + r.err);
  assert.match(r.out, /^OARC-E090 example "#1" failed: got 3; expected 2$/m);
  assert.strictEqual(read("src/m.ts"), SRC);
  assert.ok(!manifest().regions[ID]);
  assert.ok(!existsSync(join(dir, ".openarc/failed.json")) || !read(".openarc/failed.json").includes(ID));
  assert.ok(!existsSync(join(dir, ".openarc/attempts")));
  r = await oa(["accept", ID, "--json"], "return 'one';");
  const rj = JSON.parse(r.out) as { ok: boolean; id: string; problems: string[] };
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual([rj.ok, rj.id], [false, ID]);
  assert.ok(rj.problems[0]!.startsWith("OARC-E070 TS2322"), rj.problems[0]);
  assert.strictEqual(read("src/m.ts"), SRC);

  // a correct body, fenced: committed, provenance names the host
  const bodyFile = join(dir, "body.txt");
  writeFileSync(bodyFile, "```ts\nreturn n + 1;\n```\n");
  r = await oa(["accept", ID, "--file", "body.txt"]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.strictEqual(r.out.trim(), `accepted ${ID}`);
  const src = read("src/m.ts");
  assert.ok(src.includes(`// @openarc:begin ${ID}`) && src.includes("return n + 1;") && src.includes(`// @openarc:end ${ID}`), src);
  const m = manifest().regions[ID]!;
  assert.deepStrictEqual([m.ownership, m.provenance.backend, m.provenance.model, m.provenance.digest], ["compiler", "host", "host-agent", undefined]);
  r = await oa(["compile"]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.err.includes("0 model call(s)"), r.err);
  assert.strictEqual(read("src/m.ts"), src, "nothing left to compile");
  r = await oa(["accept", ID], "return n + 1;");
  assert.strictEqual(r.code, 1);
  assert.ok(r.out.includes("up to date"), r.out);

  // guard: clean, then a hand edit of the accepted region
  r = await oa(["guard"]);
  assert.strictEqual(r.code, 0, r.out + r.err);
  write("src/m.ts", src.replace("return n + 1;", "return 1 + n;"));
  r = await oa(["guard", "src/m.ts"]);
  assert.strictEqual(r.code, 1);
  assert.ok(r.out.startsWith(`src/m.ts: ${ID} is compiler-owned and was edited by hand`), r.out);
  r = await oa(["guard", "--json"]);
  assert.deepStrictEqual(JSON.parse(r.out), { ok: false, edited: [{ id: ID, file: "src/m.ts", what: "edited by hand" }] });
  write("src/other.ts", "export const x = 1;\n");
  r = await oa(["guard", "src/other.ts"]);
  assert.strictEqual(r.code, 0, "only the files named");
  write("src/m.ts", src);

  // guard --hook: before the edit, in Claude Code's PreToolUse shape
  const file = join(dir, "src/m.ts");
  r = await hook("Edit", { file_path: file, old_string: "return n + 1;", new_string: "return 2;" });
  assert.strictEqual(r.code, 2);
  assert.ok(r.err.includes(`${ID} is compiler-owned`), r.err);
  r = await hook("Edit", { file_path: file, old_string: "return n * 2;", new_string: "return n + n;" });
  assert.deepStrictEqual([r.code, r.err], [0, ""]);
  r = await hook("Write", { file_path: file, content: src.replace("Twice n.", "Double n.") });
  assert.strictEqual(r.code, 0);
  r = await hook("Write", { file_path: file, content: src.replace("return n + 1;", "return n + 2;") });
  assert.strictEqual(r.code, 2);
  r = await hook("apply_patch", { command: "*** Begin Patch\n*** Update File: src/m.ts\n@@\n-  return n + 1;\n+  return 3;\n*** End Patch\n" });
  assert.strictEqual(r.code, 2, "a Codex patch");
  r = await oa(["guard", "--hook"], "not json {");
  assert.deepStrictEqual([r.code, r.err], [0, ""]);
  r = await hook("Edit", { file_path: "/etc/hosts", old_string: "x" });
  assert.strictEqual(r.code, 0, "outside the project");

  assert.strictEqual(calls, 0, "host mode never calls the model");
  assert.ok(!existsSync(join(dir, ".openarc/usage.jsonl")), "and counts no tokens");
  console.log("host.check ok");
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
