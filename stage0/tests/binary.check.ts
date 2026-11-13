// The standalone download (tools/build-binary.ts): builds it, unpacks it, and runs it with no node on the PATH: usage,
// decompile + decompile --check + arc status on a plain-JS project, an MCP handshake and a tool call (the server
// re-runs the CLI), and `setup --yes` followed by the wrapper it wrote. On Windows: the .zip with openarc.cmd and no sh
// launcher; setup refuses clearly without sh.exe on PATH (its wrapper and hooks are sh scripts), and with Git's sh on
// PATH it writes a wrapper that sh runs.
// OPT-IN: the build copies the Node runtime (~150 MB unpacked). Skips with exit 0 unless OPENARC_BINARY_CHECK=1.
// Run: OPENARC_BINARY_CHECK=1 node --no-warnings tests/binary.check.ts
import assert from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

if (process.env.OPENARC_BINARY_CHECK !== "1") {
  console.log("binary.check skipped: set OPENARC_BINARY_CHECK=1 to build and test the standalone download");
  process.exit(0);
}

execFileSync(process.execPath, ["--no-warnings", "tools/build-binary.ts"], { stdio: "inherit" });
const win = process.platform === "win32";
const ext = win ? ".zip" : ".tar.gz";
const archive = readdirSync("build").find((f) => f.startsWith("openarc-") && f.endsWith(`-${process.platform}-${process.arch}${ext}`))!;
const sys32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
// a temp dir inside the repo's build/ (not /tmp): the unpacked tree is large
const tmp = mkdtempSync(join(resolve("build"), "binary-check-"));
try {
  execFileSync(win ? join(sys32, "tar.exe") : "tar", [win ? "-xf" : "-xzf", resolve("build", archive), "-C", tmp]);
  const home = join(tmp, archive.slice(0, -ext.length));
  const bin = join(home, "bin", win ? "openarc.cmd" : "openarc");
  if (win) assert.ok(existsSync(join(home, "bin", "node.exe")) && !existsSync(join(home, "bin", "openarc")), "Windows: bin\\node.exe and openarc.cmd, no sh launcher");
  // what a machine without node or npm sees: both shadowed by a stub that fails loudly (runners have a system node)
  const nobin = join(tmp, "no-node");
  mkdirSync(nobin);
  for (const f of ["node", "npm", "npx"]) {
    if (win) writeFileSync(join(nobin, `${f}.cmd`), `@echo binary.check: ${f} was called 1>&2\r\n@exit /b 127\r\n`);
    else writeFileSync(join(nobin, f), `#!/bin/sh\necho "binary.check: ${f} was called" >&2\nexit 127\n`, { mode: 0o755 });
  }
  const env: Record<string, string> = win
    ? { PATH: `${nobin};${sys32}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", SystemRoot: process.env.SystemRoot ?? "C:\\Windows", HOME: tmp, USERPROFILE: tmp, TEMP: tmp, TMP: tmp }
    : { PATH: `${nobin}:/usr/bin:/bin`, HOME: tmp };
  // a .cmd runs only through cmd.exe (Node refuses to spawn one without a shell); no path here has a space
  assert.strictEqual(spawnSync("node", ["-v"], { env, shell: win }).status, 127, "this PATH must not reach a real node");
  const run = (args: string[], cwd: string, e = env) => spawnSync(bin, args, { cwd, env: e, encoding: "utf8", shell: win });

  const usage = run(["--help"], tmp);
  assert.match(usage.stdout + usage.stderr, /usage: openarc init/);

  // a plain-JS project: one function and a literal call decompile observes through the sandbox
  const proj = join(tmp, "proj");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "package.json"), '{ "name": "p", "type": "module" }\n');
  writeFileSync(join(proj, "src/inc.js"), "/** Add one to n. */\nexport function inc(n) { return n + 1; }\nexport const two = inc(1);\n");
  let r = run(["decompile"], proj);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const arc = join(proj, "arc/spec/inc.arc");
  assert.match(readFileSync(arc, "utf8"), /observed \(1\) => 2/, "the sandbox ran the function with the bundled node");
  r = run(["decompile", "--check"], proj);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  writeFileSync(arc, readFileSync(arc, "utf8").replace("observed (1) => 2", "example (1) => 3"));
  r = run(["arc", "status"], proj);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /inc\.inc: stale: example \(1\) => 3: the code returns 2/);

  // MCP: handshake, then a tool that re-runs this CLI as [execPath, ...execArgv, argv[1]]
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } } });
  const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "arc_status", arguments: {} } });
  // stdin stays open until the tool replies: the server stops its children when stdin closes
  const server = spawn(bin, ["mcp"], { cwd: proj, env, stdio: ["pipe", "pipe", "inherit"], shell: win });
  server.stdin.write(`${init}\n${call}\n`);
  const replies: any[] = [];
  for await (const l of createInterface({ input: server.stdout })) if (replies.push(JSON.parse(l)) === 2) break;
  server.stdin.end();
  if (server.exitCode === null) await new Promise((done) => server.on("exit", done)); // Windows: a running bin\node.exe cannot be deleted below
  assert.strictEqual(replies[0].result.serverInfo.name, "openarc");
  assert.match(replies[1].result.content[0].text, /stale/, JSON.stringify(replies[1]));

  // setup writes a wrapper that runs this OpenArc; the wrapper works with the same node-less PATH
  const sp = join(tmp, "sp");
  mkdirSync(sp);
  execFileSync("git", ["init", "-q"], { cwd: sp }); // its own repo: setup writes agent files at the git root, not this one
  writeFileSync(join(sp, "package.json"), '{ "name": "s", "type": "module" }\n');
  let wenv = env;
  const git = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin");
  if (win) {
    // the wrapper, the guard hook and the MCP entry are sh scripts: without sh.exe setup says so and writes nothing
    r = run(["setup", "--yes", "--agents", "claude"], sp);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^openarc: setup on Windows writes sh scripts .* and no sh\.exe is on PATH: install Git for Windows/m);
    assert.ok(!existsSync(join(sp, ".openarc")) && !existsSync(join(sp, ".mcp.json")), "nothing written");
    assert.ok(existsSync(join(git, "sh.exe")), `no Git for Windows sh at ${git}`);
    wenv = { ...env, PATH: `${env.PATH};${git}` };
  }
  r = run(["setup", "--yes", "--agents", "claude"], sp, wenv);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const wrapper = join(sp, ".openarc/bin/openarc");
  const w = win ? spawnSync(join(git, "sh.exe"), [wrapper, "arc", "status"], { cwd: proj, env: wenv, encoding: "utf8" }) : spawnSync(wrapper, ["arc", "status"], { cwd: proj, env, encoding: "utf8" });
  assert.strictEqual(w.status, 1, w.stdout + w.stderr);
  assert.match(w.stdout, /inc\.inc: stale/);
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); // Windows: a file a child just closed can stay locked briefly
}
console.log("binary.check ok");
