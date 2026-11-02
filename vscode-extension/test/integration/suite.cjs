// Runs inside the VS Code extension host (run.mjs). Plain assert, no test framework: the first failure rejects run().
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const ws = process.env.OPENARC_TEST_WS;
const log = process.env.OPENARC_FAKE_LOG;
const until = async (what, f, ms = 20000) => {
  for (const end = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const step = (name) => console.log(`  ok  ${name}`);

exports.run = async () => {
  const api = await vscode.extensions.getExtension("openarc.openarc-vscode").activate();
  console.log(`  activation: ${api.activationMs} ms, of which ${api.loadMs} ms loading the modules (VS Code ${vscode.version})`);
  assert.equal(typeof api.activationMs, "number");

  const uri = vscode.Uri.file(path.join(ws, "src", "math.ts"));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const lineOf = (s) => doc.getText().split("\n").findIndex((l) => l.includes(s));

  // stale / W043, E098, E090 from the watch history, W044 from `openarc lint` (via the fake CLI)
  const diags = await until("diagnostics", () => {
    const ds = vscode.languages.getDiagnostics(uri).filter((d) => d.source === "openarc");
    return ds.some((d) => d.message.startsWith("OARC-W044")) && ds.some((d) => d.message.startsWith("OARC-W043")) && ds;
  });
  const at = (code) => diags.filter((d) => d.message.startsWith(code)).map((d) => d.range.start.line);
  assert.deepEqual(at("OARC-E098"), [lineOf("// @openarc:begin math.add")]);
  assert.deepEqual(at("OARC-W043"), [lineOf("// @openarc:begin math.sub")]);
  assert.deepEqual(at("OARC-E090"), [lineOf("// @openarc:begin math.sub")]);
  assert.deepEqual(at("OARC-W044"), [lineOf('id: "math.div"')]);
  assert.equal(diags.find((d) => d.message.startsWith("OARC-E098")).severity, vscode.DiagnosticSeverity.Error);
  step("diagnostics: E098, W043, E090, W044 on their regions and specs");

  const groups = Object.fromEntries(api.status().map((g) => [g.label, g.children.map((c) => c.label).sort()]));
  assert.deepEqual(groups, { Compiling: [], Pending: ["math.div", "math.mul"], Failed: ["math.add", "math.sub"] });
  assert.match(api.statusText(), /2 failed/);
  step("status view: pending and failed");

  // a new watch-history line reaches the status bar through the file watcher
  fs.appendFileSync(path.join(ws, ".openarc", "watch-history.jsonl"), JSON.stringify({ at: new Date().toISOString(), id: "math.mul", state: "running", ms: 0, detail: "" }) + "\n");
  await until("status bar to show the running region", () => api.statusText().includes("math.mul"));
  assert.deepEqual(api.status()[0].children.map((c) => c.label), ["math.mul"]);
  step("live status: running region from watch-history.jsonl");

  const defs = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, new vscode.Position(lineOf('id: "math.add"'), doc.lineAt(lineOf('id: "math.add"')).text.indexOf("math.add") + 1));
  assert.deepEqual(defs.map((d) => (d.range ?? d.targetRange).start.line), [lineOf("// @openarc:begin math.add")]);
  const lenses = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri);
  const titles = lenses.map((l) => l.command && l.command.title);
  assert.ok(titles.includes("Peek spec and attempts"), titles.join(" / "));
  assert.ok(titles.some((t) => /OpenArc: stale .*last compile failed: OARC-E090/.test(t)), titles.join(" / "));
  step("go to definition and CodeLens");

  await vscode.commands.executeCommand("openarc.peek", vscode.Uri.file(ws), "math.add");
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, uri.fsPath);
  step("peek opens on the region");

  const cmds = await vscode.commands.getCommands(true);
  for (const c of ["compile", "watch", "graph", "release", "freeze", "peek", "extract", "checkOracle", "backendsTest", "doctor"]) assert.ok(cmds.includes(`openarc.${c}`), c);
  await vscode.commands.executeCommand("openarc.doctor");
  await until("doctor to run", () => fs.existsSync(log) && /^doctor$/m.test(fs.readFileSync(log, "utf8")));
  const calls = fs.readFileSync(log, "utf8");
  assert.match(calls, /^graph$/m);
  assert.match(calls, /^lint --format json$/m);
  step("commands registered; doctor, graph and lint go through openarc.cliPath");
};
