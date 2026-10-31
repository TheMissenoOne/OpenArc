// 0.7.0 portability, without a real sandbox (that is tests/sandbox.check.ts). Run: node tests/isolation.check.ts
// 1. Tier selection: auto picks bwrap / sandbox-exec / node by platform and tools; explicit tiers are E092 when missing;
//    nothing picks container or unsafe-none implicitly; "none" is not a value.
// 2. The non-bwrap argv: same Node flags as bwrap (no --allow-*), the stage path as argv[3], symlinked deps readable.
// 3. CRLF: hashing a CRLF region equals hashing it with LF; a compile keeps a CRLF file CRLF.
// 4. The lock's identity falls back to pid + mtime when a filesystem reports inode 0.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "open-arc";
import type { CompileRequest } from "../src/types.ts";
import { chooseTier, readPaths, sbplProfile, tierArgv, type Tools } from "../src/isolation.ts";
import { parseConfig } from "../src/config.ts";
import { normalizeOwnedText, sha256Tagged } from "../src/hash.ts";
import { lockIdentity, statIdentity } from "../src/lock.ts";
import { run } from "../src/compile.ts";
import * as engine from "../src/engine.ts";
import fakePorts from "./fakes/ports.memory.ts";

// ── 1. tier selection
{
  const all: Tools = { bwrap: true, sandboxExec: true, container: "podman" };
  const none: Tools = { bwrap: false, sandboxExec: false, container: null };
  const tier = (want: Parameters<typeof chooseTier>[0], platform: string, tools: Tools) => {
    const c = chooseTier(want, platform, tools);
    return "error" in c ? `E092:${c.error}` : c.tier;
  };
  assert.equal(tier("auto", "linux", all), "bwrap");
  assert.equal(tier("auto", "linux", none), "node", "Linux without a usable bwrap degrades to node (with W046), never to nothing");
  assert.equal(tier("auto", "darwin", all), "sandbox-exec");
  assert.equal(tier("auto", "darwin", none), "node");
  assert.equal(tier("auto", "win32", all), "node", "Windows has no OS tier");
  assert.equal(tier("bwrap", "darwin", all), "E092:bwrap-unavailable");
  assert.equal(tier("bwrap", "linux", none), "E092:bwrap-unavailable");
  assert.equal(tier("sandbox-exec", "linux", all), "E092:sandbox-exec-unavailable");
  assert.equal(tier("container", "win32", none), "E092:no-podman-or-docker");
  assert.equal(tier("container", "win32", all), "container");
  assert.equal(tier("node", "linux", all), "node");
  assert.equal(tier("unsafe-none", "linux", all), "unsafe-none");
  const cfg = (iso: string) => parseConfig(JSON.stringify({ version: 1, backends: { l: { provider: "ollama", model: "m", maxContextTokens: 1 } }, sandbox: { isolation: iso } }));
  assert.match(cfg("none").error ?? "", /sandbox\.isolation must be one of .*"unsafe-none"/, "no implicit way to turn the sandbox off");
  assert.equal(cfg("unsafe-none").error, undefined);
  assert.equal(cfg("auto").config.sandbox?.isolation, "auto");
}

// ── 2. argv of the other tiers
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openarc-iso-")));
  try {
    mkdirSync(join(root, "lib"));
    mkdirSync(join(root, "node_modules", "@s"), { recursive: true });
    mkdirSync(join(root, "node_modules", "plain"));
    // a file: dep (npm links it): the harness must read its real path, which is outside node_modules
    symlinkSync(process.platform === "win32" ? join(root, "lib") : "../../lib", join(root, "node_modules", "@s", "dep"), "junction");
    const stage = join(root, ".openarc", "sandbox", "x");
    mkdirSync(stage, { recursive: true });
    const reads = readPaths(root, stage);
    for (const want of [stage, join(root, "node_modules"), join(root, "lib")]) assert.ok(reads.includes(want), `${want} in ${reads}`);
    assert.ok(!reads.some((r) => r.endsWith("plain")), "real package directories are covered by node_modules");
    const a = { root, stageDir: stage, nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, cpuSeconds: 10, regionId: "a.b" };
    const node = tierArgv("node", a);
    assert.deepStrictEqual(node, [
      "/n/bin/node", "--permission", ...reads.map((r) => `--allow-fs-read=${r}`),
      "--max-old-space-size=256", join(stage, ".openarc", "harness.mjs"), "a.b", stage,
    ]);
    assert.ok(!node.some((x) => /^--allow-(net|child-process|worker|addons|wasi|fs-write)/.test(x)), "no grant beyond fs-read");
    const sx = tierArgv("sandbox-exec", a);
    assert.deepStrictEqual([sx[0], sx[1], sx.slice(3)], ["sandbox-exec", "-p", node]);
    assert.match(sx[2]!, /\(deny network\*\)\n\(deny file-write\*\)/);
    assert.ok(sx[2]!.includes(`(subpath ${JSON.stringify(stage)})`), "the stage is readable under sandbox-exec");
    assert.match(sbplProfile(['/a "q"'], "/n"), /\(subpath "\/a \\"q\\""\)/, "SBPL strings are escaped");
    const c = tierArgv("container", { ...a, containerImage: "img" });
    assert.ok(c.includes("--network=none") && c.includes(`${stage}:/work:ro`) && c.includes("img"));
    assert.deepStrictEqual(c.slice(-5), ["--permission", "--allow-fs-read=/work", "--max-old-space-size=256", "/work/.openarc/harness.mjs", "a.b"]);
    assert.ok(!tierArgv("unsafe-none", a).includes("--permission"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── 3. CRLF
{
  const lf = ["const t = `a", "b`; // c", "return t;"];
  const crlf = lf.map((l) => `${l}\r`);
  assert.equal(sha256Tagged(normalizeOwnedText(crlf, [])), sha256Tagged(normalizeOwnedText(lf, [])), "CRLF hashes like LF");

  // A whole compile on a CRLF file: the region hash is the LF one, and the committed file is CRLF throughout.
  const src = (body: string) => [
    'import * as arc from "open-arc";',
    "type Inc = (n: number) => number;",
    'export const incSpec = arc.defineRegion<Inc>({ id: "fx.inc", intent: "add one", examples: [{ args: [1], expected: 2 }] });',
    "// @openarc:begin fx.inc",
    body,
    "// @openarc:end fx.inc",
    "",
  ].join("\n");
  const pending = src('export const inc: Inc = (n) => arc.todo("fx.inc");');
  const req: CompileRequest = { root: process.cwd(), ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
  const hashOf = async (text: string) => {
    const ports = fakePorts({ files: { "src/fx.ts": text } }).instance;
    const p = await engine.parse(ports, req, []);
    await engine.analyze(ports, req, p, [], { offline: true });
    return p.regions[0]!.hash;
  };
  assert.equal(await hashOf(pending.replaceAll("\n", "\r\n")), await hashOf(pending), "the analyzed region hash ignores line endings");

  const fake = fakePorts({
    files: { "src/fx.ts": pending.replaceAll("\n", "\r\n"), ".openarc/manifest.json": '{"schema":1,"regions":{}}' },
    http: ['{"models":[{"name":"qwen3.5:9b","digest":"d1"}]}', JSON.stringify({ message: { role: "assistant", content: '{"body":"return n + 1;"}' }, done: true })],
    proc: [{ code: 0, stdout: "", timedOut: false }, { code: 0, stdout: '{"name":"#1","ok":true}\n{"done":1}\n', timedOut: false }],
  });
  const res = await run(fake.instance, req);
  assert.equal(res.exit, 0, JSON.stringify(res.diagnostics));
  const files = (fake.snapshot() as { files: Record<string, string> }).files;
  const out = files["src/fx.ts"]!;
  assert.equal(out, src("export const inc: Inc = (n) => {\n  return n + 1;\n};").replaceAll("\n", "\r\n"), "committed with CRLF throughout");
  const m = JSON.parse(files[".openarc/manifest.json"]!) as { regions: Record<string, { hash: Json }> };
  assert.equal(m.regions["fx.inc"]!.hash, await hashOf(out.replaceAll("\r\n", "\n")), "manifest hash = the LF hash");
  // a file with mixed endings is left byte for byte as it was
  const mixed = pending.replace("\n", "\r\n");
  const keep = fakePorts({ files: { "src/fx.ts": mixed } }).instance;
  const p = await engine.parse(keep, req, []);
  assert.equal(p.files.get("src/fx.ts"), mixed);
  assert.equal(engine.toDisk(p, "src/fx.ts", mixed), mixed);
}

// ── 4. lock identity
{
  const dir = mkdtempSync(join(tmpdir(), "openarc-lockid-"));
  try {
    const f = join(dir, "lock");
    writeFileSync(f, "123");
    assert.match(lockIdentity(f), process.platform === "win32" ? /^(ino:\d+|pid:123@[\d.]+)$/ : /^ino:\d+$/);
    assert.equal(statIdentity({ ino: 0, mtimeMs: 5.5 }, "123"), "pid:123@5.5", "no inode: pid + mtime");
    assert.notEqual(statIdentity({ ino: 0, mtimeMs: 5.5 }, "123"), statIdentity({ ino: 0, mtimeMs: 5.5 }, "456"), "a replacement lock (other pid) differs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("isolation.check: ok");
