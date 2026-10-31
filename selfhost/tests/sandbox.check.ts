// The real sandbox on this OS, no model: a temp project, `openarc doctor`, and a real `openarc compile` against a fake
// Ollama server. Run: node tests/sandbox.check.ts
// For the auto tier (bwrap on Linux, sandbox-exec on macOS, node on Windows) and the forced "node" tier:
// 1. doctor: 1 + 1 inside the sandbox, and a file write, a child process and a network request are all refused.
// 2. compile: the stub's first body fails the examples in the sandbox, its second passes and is committed. A CRLF
//    source (the forced-node run) stays CRLF.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeBlocksNetwork, probeTools } from "../src/isolation.ts";
import { NETWORK_DENIED } from "../src/engine.ts";

const stage0 = process.cwd();
const main = join(stage0, "src", "main.ts");
const cli = (cwd: string, ...args: string[]) =>
  new Promise<{ code: number; out: string }>((done) =>
    execFile(process.execPath, [main, ...args], { cwd, encoding: "utf8", timeout: 180_000 }, (e, stdout, stderr) =>
      done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout}${stderr}` })));

// fake Ollama: /api/tags, then one /api/chat reply per call from `bodies`
let bodies: string[] = [];
let chats = 0;
const server = createServer((rq, rs) => {
  let body = "";
  rq.on("data", (b) => (body += b));
  rq.on("end", () => {
    rs.setHeader("content-type", "application/json");
    if (rq.url === "/api/tags") return rs.end(JSON.stringify({ models: [{ name: "stub:1", digest: "d1" }] }));
    if (rq.url === "/api/chat") return rs.end(JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ body: bodies[chats++] ?? "return 0;" }) }, done: true }));
    rs.statusCode = 404;
    rs.end("{}");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const SPEC = [
  'import * as arc from "open-arc";',
  "type Inc = (n: number) => number;",
  'export const incSpec = arc.defineRegion<Inc>({ id: "demo.inc", intent: "add one", examples: [{ args: [1], expected: 2 }, { args: [0], expected: 1 }, { args: [-1], expected: 0 }] });',
  "",
].join("\n");

const tools = probeTools();
const tiers: [string, string][] = [["auto", process.platform === "linux" && tools.bwrap ? "bwrap" : process.platform === "darwin" && tools.sandboxExec ? "sandbox-exec" : "node"], ["node", "node"]];
if (process.env.OPENARC_TEST_CONTAINER) tiers.push(["container", "container"]); // opt-in: pulls node:<version>-slim
if (process.platform === "linux" && !tools.bwrap) console.log("sandbox.check: note: bwrap unusable here (missing, or user namespaces restricted): auto = node");
try {
  for (const [iso, want] of tiers) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "openarc-sbx-")));
    try {
      // a project like stage0 itself: open-arc is a file: dependency on a copy of core/
      cpSync(join(stage0, "core"), join(dir, "core"), { recursive: true });
      mkdirSync(join(dir, "node_modules"));
      symlinkSync(process.platform === "win32" ? join(dir, "core") : "../core", join(dir, "node_modules", "open-arc"), "junction");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sbx", private: true, type: "module", dependencies: { "open-arc": "file:./core" } }));
      assert.equal((await cli(dir, "init")).code, 0);
      writeFileSync(join(dir, "openarc.config.json"), JSON.stringify({
        version: 1,
        backends: { stub: { provider: "ollama", model: "stub:1", host: `http://127.0.0.1:${port}`, maxContextTokens: 8192 } },
        compilation: { defaultBackend: "stub", maxAttempts: 3 },
        sandbox: { isolation: iso },
      }));

      const doc = await cli(dir, "doctor");
      assert.equal(doc.code, 0, doc.out);
      assert.match(doc.out, new RegExp(`isolation: ${iso} -> ${want} `), doc.out);
      assert.match(doc.out, /example: ok/);
      assert.match(doc.out, /file write +blocked/);
      assert.match(doc.out, /child process +blocked/);
      if (want !== "node" || nodeBlocksNetwork()) {
        const net = /network +blocked \((\w+)\)/.exec(doc.out);
        assert.ok(net && NETWORK_DENIED.includes(net[1]!), `the connection to doctor's own socket is denied, not just failed: ${doc.out}`);
      }
      if (want === "node") assert.match(doc.out, /OARC-W046/);

      const crlf = iso === "node";
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "inc.ts"), crlf ? SPEC.replaceAll("\n", "\r\n") : SPEC);
      assert.equal((await cli(dir, "scaffold")).code, 0);
      bodies = ["return n - 1;", "return n + 1;"];
      chats = 0;
      const c = await cli(dir, "compile");
      assert.equal(c.code, 0, c.out);
      assert.match(c.out, /done: exit 0 · 2 model call\(s\)/, c.out);
      const text = readFileSync(join(dir, "src", "inc.ts"), "utf8");
      assert.ok(text.includes("return n + 1;"), text);
      if (crlf) assert.ok(!/[^\r]\n/.test(text), "the CRLF file is still CRLF");
      const m = JSON.parse(readFileSync(join(dir, ".openarc", "manifest.json"), "utf8"));
      assert.deepStrictEqual(m.regions["demo.inc"].provenance.verifiedBy, ["tsc", "static", "examples:3/3"]);
      const g = await cli(dir, "graph");
      assert.match(g.out, /demo\.inc +F compiler/, g.out);
      console.log(`sandbox.check: ${iso} -> ${want}: doctor ok, compile ok (attempt 1 failed its examples in the sandbox)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
} finally {
  server.close();
}
console.log("sandbox.check: ok");
