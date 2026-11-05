// `openarc adopt` and `openarc sync`, end to end: the real CLI, a temp project, a stub model that counts its calls.
// Run: node --no-warnings tests/sync.check.ts
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Json } from "open-arc";
import { join, resolve } from "node:path";
import { exampleLine, parseSheet, readExample, renderSheet } from "../src/sheet.ts";
import { cliReply, cliRequest } from "../src/backends.ts";
import { parseConfig } from "../src/config.ts";
import { inputsFor } from "../src/sync.ts";

// ── pure: the sheet round-trips, and an unreadable line is an error rather than a loss
{
  const cases: Json[] = [{ args: [1, " -> "], expected: " # " }, { name: "a # b", args: [], expected: null }, { args: [{ $fake: "x" }], expected: 1, fakesAfter: {} }];
  for (const e of cases) assert.deepStrictEqual(readExample(exampleLine(e)), e);
  const sheet = { regions: [{ id: "a.b", file: "src/a.ts", meta: "owner: developer", signature: "(x: number): number", intent: "Line one.\nLine two.", examples: [{ args: [1], expected: 2 }], hold: true, notes: ["a note"], suggestions: [{ kind: "example" as const, value: "[1] -> 3", note: "why", checked: false }] }], notAdopted: [{ ref: "src/a.ts#f", checked: false }] };
  const text = renderSheet(sheet);
  const back = parseSheet(text);
  assert.deepStrictEqual(back.errors, []);
  assert.strictEqual(renderSheet({ regions: back.sheet.regions.map((r) => ({ ...r, meta: "owner: developer", notes: ["a note"] })), notAdopted: back.sheet.notAdopted }), text);
  assert.ok(parseSheet(text.replace("[1] -> 2", "[1] => 2")).errors[0]!.includes("cannot read this example"));
}
// ── pure: inputs vary per parameter, and an unknowable type means no inputs
assert.deepStrictEqual(inputsFor([[0, 1], ["a"]]), [[0, "a"], [1, "a"]]);
assert.strictEqual(inputsFor([[0], null]), null);
// ── agent CLIs: fixed argv, the prompt on stdin, nothing from the config runs as a command
{
  const b = parseConfig(JSON.stringify({ version: 1, backends: { c: { provider: "claude-cli", model: "m", maxContextTokens: 1000 } }, compilation: { defaultBackend: "c" } })).config.backends.c!;
  assert.deepStrictEqual([b.provider, b.cli, b.outputFormat], ["cli", "claude", "code"]);
  const r = cliRequest(b, "SYS", "USER");
  assert.strictEqual(r.argv[0], "claude");
  assert.strictEqual(r.stdin, "USER");
  assert.ok(r.argv.includes("--no-session-persistence") && r.argv[r.argv.indexOf("--tools") + 1] === "");
  assert.deepStrictEqual(cliReply(b, JSON.stringify({ result: "hi", usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 1 } })), { text: "hi", truncated: false, tokens: { prompt: 5, completion: 1 } });
  assert.throws(() => cliReply(b, JSON.stringify({ is_error: true, result: "limit" })), /limit/);
  const codex = { ...b, cli: "codex" as const };
  assert.deepStrictEqual(cliReply(codex, `{"type":"item.completed","item":{"type":"agent_message","text":"yo"}}\n{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":2}}\n`), { text: "yo", truncated: false, tokens: { prompt: 7, completion: 2 } });
  const op = { ...b, cli: "opencode" as const };
  assert.deepStrictEqual(cliReply(op, `{"type":"text","part":{"text":"ok"}}\n{"type":"step_finish","part":{"tokens":{"input":4,"output":1}}}\n`), { text: "ok", truncated: false, tokens: { prompt: 4, completion: 1 } });
}

// ── end to end (a symlinked node_modules: Windows CI is covered by the pure checks above)
if (process.platform === "win32") {
  console.log("sync.check ok (pure checks only on Windows)");
  process.exit(0);
}
const MAIN = resolve("src/main.ts");
const dir = mkdtempSync(join(resolve(".."), ".sync-check-"));
let calls = 0;
let reply = (_user: string): string => JSON.stringify({ body: "throw new Error('unexpected model call');", imports: [] });
const server = createServer((req, res) => {
  let data = "";
  req.on("data", (d) => (data += d));
  req.on("end", () => {
    const user = (JSON.parse(data) as { messages: { role: string; content: string }[] }).messages.at(-1)!.content;
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: reply(user) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const oa = (...args: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
  const c = spawn(process.execPath, ["--no-warnings", MAIN, ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (b) => (out += b));
  c.stderr.on("data", (b) => (out += b));
  c.on("close", (code) => done({ code, out }));
});
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const write = (f: string, t: string) => writeFileSync(join(dir, f), t);
const SHEET = "openarc.spec.md";
const editSheet = (a: string, b: string) => { const t = read(SHEET); assert.ok(t.includes(a), `sheet has ${a}:\n${t}`); write(SHEET, t.replace(a, b)); };
const manifest = () => JSON.parse(read(".openarc/manifest.json")) as { regions: Record<string, { ownership: string; specHash: string }> };
const sync = async (...flags: string[]) => {
  const r = await oa("sync", "--json", ...flags);
  const line = r.out.split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, `sync printed no status: ${r.out}`);
  return JSON.parse(line) as { applied: string[]; pulled: string[]; compiled: string[]; modelCalls: number; attention: { id: string; what: string }[]; suggestions: number; localTokensToday: number; error?: string };
};
try {
  mkdirSync(join(dir, "src"));
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
  write("package.json", '{"name":"plain","version":"1.0.0","type":"module","private":true}');
  write("tsconfig.json", '{"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noEmit":true,"allowImportingTsExtensions":true,"skipLibCheck":true},"include":["src"]}');
  const body = "export function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, n));\n}\n";
  write("src/text.ts", `/** Lower-case words joined by dashes. */\nexport function slug(title: string): string {\n  return title.trim().toLowerCase().split(/\\s+/).join("-");\n}\n\n${body}\nexport interface Port { send(x: string): void }\nexport function usesPort(p: Port): void {\n  p.send("x");\n}\n`);
  write("openarc.config.json", JSON.stringify({ version: 1, backends: { local: { provider: "local", baseUrl: `http://127.0.0.1:${port}/v1`, model: "stub", maxContextTokens: 8192 } }, compilation: { defaultBackend: "local", maxAttempts: 1, batch: "off" }, sandbox: { isolation: "unsafe-none" } }));

  // adopt: every body byte-identical, specs recorded from the code, no model call for what types can answer
  reply = () => JSON.stringify({ intent: "Described by the stub.", inputs: [] });
  const adopted = await oa("adopt");
  assert.strictEqual(adopted.code, 0, adopted.out);
  assert.ok(read("src/text.ts").includes("return Math.min(hi, Math.max(lo, n));"));
  const sheet0 = read(SHEET);
  assert.ok(sheet0.includes('["Hello World"] -> "hello-world"'), sheet0);
  assert.ok(existsSync(join(dir, "src/text.arc.ts")));
  assert.strictEqual(manifest().regions["text.slug"]!.ownership, "developer");
  const adoptCalls = calls;
  assert.strictEqual(adoptCalls, 2, "the two functions with no JSDoc are described, once each"); // clamp, usesPort
  assert.ok(read("src/text.ts").includes("Described by the stub."));

  // a repeat costs nothing and changes nothing
  let s = await sync();
  assert.strictEqual(calls, adoptCalls);
  assert.strictEqual(read(SHEET), sheet0);
  assert.deepStrictEqual([s.applied, s.compiled], [[], []]);

  // an example the current body already satisfies: applied, no model call, still the developer's
  editSheet('["Hello World"] -> "hello-world"', '["Hello World"] -> "hello-world"\n- ["A  B"] -> "a-b"');
  s = await sync();
  assert.deepStrictEqual(s.applied, ["text.slug"]);
  assert.strictEqual(calls, adoptCalls, "no model call when the body already passes");
  assert.strictEqual(manifest().regions["text.slug"]!.ownership, "developer");
  assert.ok(read("src/text.arc.ts").includes('"A  B"'));

  // an example it doesn't satisfy: the spec drives the code. The old body is backed up, the new one verified.
  reply = () => JSON.stringify({ body: 'return title.trim().toLowerCase().split(/\\s+/).join("_");', imports: [] });
  for (const line of read(SHEET).split("\n").filter((l) => /^- \[.*\] -> "/.test(l) && l.includes("-"))) editSheet(line, line.replace(/-(?=[a-z]+"$)/, "_"));
  const before = calls;
  s = await sync();
  assert.ok(calls > before, "the spec edit reached the model");
  assert.deepStrictEqual(s.compiled, ["text.slug"], JSON.stringify(s));
  assert.ok(read("src/text.ts").includes('join("_")'));
  assert.strictEqual(manifest().regions["text.slug"]!.ownership, "compiler");
  assert.ok(readdirSync(join(dir, ".openarc/backup")).some((f) => f.startsWith("text.slug.")));

  // a generated body isn't a hand edit: no suggestions from it
  assert.strictEqual(s.suggestions, 0);

  // a failing regeneration keeps today's body and says so
  reply = () => JSON.stringify({ body: 'return "nope";', imports: [] });
  editSheet('["Hello World"] -> "hello_world"', '["Hello World"] -> "hello__world"');
  s = await sync();
  assert.ok(s.attention.some((a) => a.id === "text.slug" && a.what.startsWith("compile failed")), JSON.stringify(s.attention));
  assert.ok(read("src/text.ts").includes('join("_")'), "the old body stays");
  editSheet('["Hello World"] -> "hello__world"', '["Hello World"] -> "hello_world"');
  await sync();

  // a hand edit: re-running the examples suggests new ones with no model call; ticking applies them
  const beforeHand = calls;
  write("src/text.ts", read("src/text.ts").replace("return Math.min(hi, Math.max(lo, n));", "return Math.min(hi, Math.max(lo, n)) + 1;"));
  s = await sync();
  assert.strictEqual(calls, beforeHand, "drift is found without a model");
  assert.ok(s.suggestions > 0);
  const suggested = read(SHEET);
  assert.ok(/- \[ \] example: /.test(suggested), suggested);
  assert.ok(!read("src/text.arc.ts").includes("__never__"));
  const clampBefore = read("src/text.arc.ts");
  write(SHEET, suggested.replace("- [ ] example: ", "- [x] example: "));
  s = await sync();
  assert.ok(s.applied.includes("text.clamp"), JSON.stringify(s));
  assert.notStrictEqual(read("src/text.arc.ts"), clampBefore);
  assert.strictEqual(calls, beforeHand, "accepting a suggestion never regenerates the body it came from");
  assert.ok(read("src/text.ts").includes("Math.max(lo, n)) + 1;"), "the hand edit stands");

  // JSDoc edited in the code reaches the sheet
  write("src/text.ts", read("src/text.ts").replace("Lower-case words joined by dashes.", "Lower-case words joined by underscores."));
  s = await sync("--no-model");
  assert.ok(read(SHEET).includes("Lower-case words joined by underscores."));
  assert.ok(s.pulled.includes("text.slug"), JSON.stringify(s));

  // edited on both sides: the code's version stands and a person is told
  editSheet("Lower-case words joined by underscores.", "From the sheet.");
  write("src/text.ts", read("src/text.ts").replace("Lower-case words joined by underscores.", "From the code."));
  s = await sync("--no-model");
  assert.ok(s.attention.some((a) => a.id === "text.slug" && a.what.includes("both")), JSON.stringify(s.attention));
  assert.ok(read("src/text.ts").includes("From the code."));
  assert.ok(read(SHEET).includes("From the code."));

  // no example and no test: the sheet can edit its intent, but no body is replaced with nothing to check it
  const ownersBefore = manifest().regions["text.usesPort"]!.ownership;
  editSheet("## text.usesPort", "## text.usesPort");
  const t = read(SHEET);
  const i = t.indexOf("## text.usesPort");
  write(SHEET, t.slice(0, i) + t.slice(i).replace("Described by the stub.", "Sends x on the port."));
  s = await sync("--no-model");
  assert.ok(s.attention.some((a) => a.id === "text.usesPort" && a.what.includes("needs an example")), JSON.stringify(s.attention));
  assert.strictEqual(manifest().regions["text.usesPort"]!.ownership, ownersBefore);
  assert.ok(read("src/text.ts").includes('p.send("x");'));

  // a new section writes a pending function and compiles it
  reply = () => JSON.stringify({ body: "return x * 2;", imports: [] });
  write(SHEET, `${read(SHEET).trimEnd()}\n\n## text.double\n<!-- file: src/text.ts -->\n\`double(x: number): number\`\n\nDoubles a number.\n\n**Examples**\n- [2] -> 4\n`);
  s = await sync();
  assert.ok(s.compiled.includes("text.double"), JSON.stringify(s));
  assert.ok(read("src/text.ts").includes("return x * 2;"));
  assert.ok(read(SHEET).includes("[2] -> 4"), "the section's example is now the region's");

  // an unreadable sheet is reported and left exactly as it is
  const bad = read(SHEET).replace("[2] -> 4", "[2] => 4");
  write(SHEET, bad);
  s = await sync();
  assert.ok(s.error?.includes("cannot read this example"));
  assert.strictEqual(read(SHEET), bad);
  write(SHEET, bad.replace("[2] => 4", "[2] -> 4"));

  // usage is on record, by model
  assert.ok(read(".openarc/usage.jsonl").split("\n").filter(Boolean).every((l) => (JSON.parse(l) as { hosted: boolean }).hosted === false));
  console.log("sync.check ok");
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
