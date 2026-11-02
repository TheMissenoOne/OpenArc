import { t0 } from "./t0"; // first: the activation time includes loading the modules below
import * as vscode from "vscode";
import { execFile } from "child_process";
import { parse, positionAt, Parsed, Region, Spec } from "./parse";
import { codeOf, Finding, HistoryEntry, lastPerRegion, MESSAGES, parseGraph, parseLint, safeArg } from "./records";

type State = "pending" | "compiler" | "developer" | "conflicted";
type Display = State | "stale";
interface Entry { ownership: State; provenance?: { model?: string; attempts?: number; contextLevel?: number; verifiedBy?: string[] } }
interface FileInfo { uri: vscode.Uri; root: vscode.Uri; parsed: Parsed }
/** What the CLI left on disk (watch history, failed.json) or printed (`graph`, `lint`), per project. */
interface Live { history: Map<string, HistoryEntry>; failed: Record<string, { detail?: string }>; graph: Map<string, string>; lint: Finding[] }

const ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
const TS_EXCLUDE = "{**/node_modules/**,**/.openarc/**,**/*.d.ts}";
// Windows: the file system is case-insensitive, and one file can come back as /c:/x or /C:/x (findFiles vs. open documents).
const WIN = process.platform === "win32";
const pathKey = (uri: vscode.Uri) => (WIN ? uri.path.toLowerCase() : uri.path);
const uriKey = (uri: vscode.Uri) => (WIN ? uri.toString().toLowerCase() : uri.toString());

let roots: vscode.Uri[] = []; // folders holding openarc.config.json, deepest first
const manifests = new Map<string, Record<string, Entry>>(); // pathKey(root) -> regions
const live = new Map<string, Live>(); // pathKey(root) -> CLI state
const files = new Map<string, FileInfo>(); // uriKey -> parsed file
let specIndex = new Map<string, { file: FileInfo; spec: Spec }>(); // pathKey(root) + "\0" + id
let regionIndex = new Map<string, { file: FileInfo; region: Region }>();

const lensChanged = new vscode.EventEmitter<void>();
const treeChanged = new vscode.EventEmitter<void>();
const STATES: State[] = ["pending", "compiler", "developer", "conflicted"];
const tints = new Map(STATES.map((s) => [s, vscode.window.createTextEditorDecorationType({
  isWholeLine: true, backgroundColor: new vscode.ThemeColor(`openarc.${s}Background`),
})]));
let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;

const key = (root: vscode.Uri, id: string) => `${pathKey(root)}\0${id}`;
const rootOf = (uri: vscode.Uri) => roots.find((r) => pathKey(uri).startsWith(pathKey(r) + "/"));
const sameRoot = (a: vscode.Uri, b: vscode.Uri) => pathKey(a) === pathKey(b);
// The CLI reads specs and markers only under <root>/src/ (engine srcFiles); other files never enter the index.
const inSrc = (uri: vscode.Uri, root: vscode.Uri) => pathKey(uri).startsWith(pathKey(root) + "/src/");
const pos = (f: FileInfo, offset: number) => { const p = positionAt(f.parsed.lineStarts, offset); return new vscode.Position(p.line, p.character); };
const range = (f: FileInfo, start: number, end: number) => new vscode.Range(pos(f, start), pos(f, end));
const liveOf = (root: vscode.Uri): Live => {
  let l = live.get(pathKey(root));
  if (!l) live.set(pathKey(root), l = { history: new Map(), failed: {}, graph: new Map(), lint: [] });
  return l;
};

function stateOf(root: vscode.Uri, id: string): State {
  const entry = manifests.get(pathKey(root))?.[id];
  if (entry) return entry.ownership;
  const r = regionIndex.get(key(root, id))?.region;
  return !r || r.placeholder ? "pending" : "developer"; // §6.2: no entry -> pending if placeholder, else extracted
}

/** §6.3.1: `stale` is derived by the CLI (specHash/fingerprint), so it comes from the last `openarc graph`. */
function displayOf(root: vscode.Uri, id: string): Display {
  const s = stateOf(root, id);
  return s === "compiler" && liveOf(root).graph.get(id) === "stale" ? "stale" : s;
}

/** Why the last compile of a still pending or stale region failed: the watch history first, then failed.json (E082). */
function failureOf(root: vscode.Uri, id: string): string | undefined {
  const d = displayOf(root, id);
  if (d !== "pending" && d !== "stale") return; // compiled (or taken over) since: the old failure no longer applies
  const l = liveOf(root);
  const h = l.history.get(id);
  if (h?.state === "failed") return h.detail || "failed";
  const f = l.failed[id];
  if (f) return codeOf(f.detail ?? "") ? f.detail : `OARC-E082 ${f.detail ?? ""}`.trim();
}

// ── indexing ────────────────────────────────────────────────────────────────

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; }
}

async function loadManifest(root: vscode.Uri, retries = 3): Promise<void> {
  const raw = await readText(vscode.Uri.joinPath(root, ".openarc", "manifest.json"));
  if (raw === undefined) return void manifests.set(pathKey(root), {}); // no manifest: every region falls back to §6.2
  try {
    manifests.set(pathKey(root), JSON.parse(raw).regions ?? {});
  } catch { // caught mid-write: keep the previous state and read again shortly
    if (retries > 0) setTimeout(() => loadManifest(root, retries - 1).then(scheduleRefresh), 300);
  }
}

/** .openarc/watch-history.jsonl and .openarc/failed.json. Both are rewritten whole, so a torn read is retried by the next change event. */
async function loadLive(root: vscode.Uri): Promise<void> {
  const l = liveOf(root);
  l.history = lastPerRegion((await readText(vscode.Uri.joinPath(root, ".openarc", "watch-history.jsonl"))) ?? "");
  try {
    const f: unknown = JSON.parse((await readText(vscode.Uri.joinPath(root, ".openarc", "failed.json"))) ?? "{}");
    l.failed = f && typeof f === "object" && !Array.isArray(f) ? f as Live["failed"] : {};
  } catch { /* mid-write: keep the previous state */ }
}

function setFile(uri: vscode.Uri, text: string) {
  const root = rootOf(uri);
  if (root && inSrc(uri, root)) files.set(uriKey(uri), { uri, root, parsed: parse(text, uri.path) });
}

async function readFromDisk(uri: vscode.Uri) {
  const openText = () => vscode.workspace.textDocuments.find((d) => uriKey(d.uri) === uriKey(uri))?.getText();
  let text = openText();
  if (text === undefined) {
    text = await readText(uri);
    if (text === undefined) return void files.delete(uriKey(uri));
    text = openText() ?? text; // opened and edited while we were reading: the editor text is newer
  }
  setFile(uri, text);
}

let timer: unknown;
function scheduleRefresh() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 150);
}

const diag = (r: vscode.Range, message: string, severity: vscode.DiagnosticSeverity) =>
  Object.assign(new vscode.Diagnostic(r, message, severity), { source: "openarc" });
const { Error: ERROR, Warning: WARNING, Information: INFO } = vscode.DiagnosticSeverity;

/** "OARC-E098 engine.parse" -> "OARC-E098: call not allowed by ... [engine.parse]". */
function failureMessage(detail: string): string {
  const code = codeOf(detail);
  if (!code) return `compile failed: ${detail}`;
  const rest = detail.slice(code.length).trim();
  return `${code}: ${MESSAGES[code] ?? "compile failed"}${rest ? ` [${rest}]` : ""}`;
}

function refresh() {
  specIndex = new Map();
  regionIndex = new Map();
  for (const file of files.values()) {
    for (const spec of file.parsed.specs) specIndex.set(key(file.root, spec.id), { file, spec });
    for (const region of file.parsed.regions) regionIndex.set(key(file.root, region.id), { file, region });
  }
  diagnostics.clear();
  // Pairing stops at the first E030/E031, so a root with one hides later regions: "no markers yet" would be a false alarm.
  const broken = new Set([...files.values()].filter((f) => f.parsed.problems.some((p) => p.code === "OARC-E030" || p.code === "OARC-E031")).map((f) => pathKey(f.root)));
  for (const file of files.values()) {
    const ds = file.parsed.problems.map((p) => diag(range(file, p.start, p.end), p.message, p.severity === "error" ? ERROR : WARNING));
    for (const m of file.parsed.markers) {
      if (m.kind === "begin" && !specIndex.has(key(file.root, m.id)))
        ds.push(diag(range(file, m.idStart, m.idEnd), `OARC-E012: no defineRegion/defineBlock spec with id '${m.id}'`, ERROR));
    }
    for (const s of file.parsed.specs) {
      if (!broken.has(pathKey(file.root)) && !regionIndex.has(key(file.root, s.id)))
        ds.push(diag(range(file, s.idStart, s.idEnd), `'${s.id}' has no markers yet: run openarc scaffold`, INFO));
    }
    // compile results on the begin marker: stale / W043, and the last failure (E098, W045, E090, ...)
    for (const r of file.parsed.regions) {
      const at = range(file, r.begin.idStart, r.begin.idEnd);
      const fail = failureOf(file.root, r.id);
      if (displayOf(file.root, r.id) === "stale")
        ds.push(diag(at, fail ? `OARC-W043: ${MESSAGES["OARC-W043"]}` : "stale: the spec changed since this body was verified; it may not satisfy the current examples (openarc compile)", WARNING));
      if (fail) ds.push(diag(at, failureMessage(fail), codeOf(fail)?.startsWith("OARC-W") ? WARNING : ERROR));
    }
    // `openarc lint` spec findings on the spec id (spec/thin-examples is W044's condition)
    for (const f of liveOf(file.root).lint) {
      const s = f.rule.startsWith("spec/") && file.parsed.specs.find((x) => x.id === f.id);
      if (s) ds.push(diag(range(file, s.idStart, s.idEnd), `${f.rule === "spec/thin-examples" ? "OARC-W044" : f.rule}: ${f.message}`, f.severity === "error" ? ERROR : WARNING));
    }
    if (ds.length) diagnostics.set(file.uri, ds);
  }
  lensChanged.fire();
  vscode.window.visibleTextEditors.forEach(decorate);
  buildStatus();
}

function decorate(editor: vscode.TextEditor) {
  const file = files.get(uriKey(editor.document.uri));
  for (const s of STATES) {
    const ranges = file?.parsed.regions.filter((r) => stateOf(file.root, r.id) === s)
      .map((r) => new vscode.Range(r.begin.line, 0, r.end.line, 0)) ?? [];
    editor.setDecorations(tints.get(s)!, ranges);
  }
}

// ── the CLI: background analysis and commands ───────────────────────────────

const SCRIPT = /\.(m?js|cjs|ts)$/i;
const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
/** argv prefix for the CLI: `openarc.cliPath` (a script runs with node), else the project's own install via npx.
 *  `--no`: never download a package that happens to be named openarc. */
function cliPrefix(): string[] {
  const p = vscode.workspace.getConfiguration("openarc").get<string>("cliPath")?.trim();
  return !p ? ["npx", "--no", "openarc"] : SCRIPT.test(p) ? ["node", p] : [p];
}

function runCli(root: vscode.Uri, args: string[]): Promise<{ error: Error | null; stdout: string; stderr: string }> {
  const [file, ...argv] = [...cliPrefix(), ...args];
  // Windows: npx is npx.cmd, which only a shell runs. With a shell the arguments are joined, so pass one command line
  // (every argument is validated or fixed; only a configured cliPath may hold spaces).
  const shell = WIN && !/^node$|\.exe$/i.test(file);
  return new Promise((done) => execFile(shell ? [file, ...argv].map(quote).join(" ") : file, shell ? [] : argv,
    { cwd: root.fsPath, shell, maxBuffer: 16 << 20 }, (error, stdout, stderr) => done({ error, stdout, stderr })));
}

function inTerminal(root: vscode.Uri, args: string[], label = "OpenArc") {
  const name = `${label}: ${vscode.workspace.asRelativePath(root)}`;
  const term = vscode.window.terminals.find((t) => t.name === name && t.exitStatus === undefined)
    ?? vscode.window.createTerminal({ name, cwd: root });
  term.show();
  const cmd = /cmd(\.exe)?$/i.test(vscode.env.shell); // cmd.exe needs /d to change drives
  const ps = /(pwsh|powershell)(\.exe)?$/i.test(vscode.env.shell); // PowerShell runs a quoted path only after &
  // A reused terminal may have been cd'ed elsewhere.
  if (!root.fsPath.includes('"')) term.sendText(`cd ${cmd ? "/d " : ""}"${root.fsPath}"`);
  const line = [...cliPrefix(), ...args].map(quote).join(" ");
  term.sendText(ps && line.startsWith('"') ? `& ${line}` : line);
}

async function toOutput(root: vscode.Uri, args: string[]) {
  output.show(true);
  output.appendLine(`$ openarc ${args.join(" ")}   (${root.fsPath})`);
  const { error, stdout, stderr } = await runCli(root, args);
  if (stdout) output.append(stdout);
  if (stderr) output.append(stderr);
  if (error) output.appendLine(`[failed] ${error.message}`);
}

// `openarc graph` (display states, for stale) and `openarc lint --format json` (W044 and spec rules). Both are offline:
// no model, no sandbox. They run after a save or a manifest change, debounced, one process at a time across projects.
const cliDirty = new Set<string>();
let cliTimer: unknown;
let cliBusy = false;
const cliWarned = new Set<string>();
function scheduleAnalysis(root: vscode.Uri) {
  cliDirty.add(pathKey(root));
  clearTimeout(cliTimer);
  cliTimer = setTimeout(drainAnalysis, 1500);
}
async function drainAnalysis() {
  if (cliBusy) return;
  cliBusy = true;
  try {
    for (const k of cliDirty) {
      cliDirty.delete(k);
      const root = roots.find((r) => pathKey(r) === k);
      if (!root) continue;
      const graph = await runCli(root, ["graph"]);
      const lint = await runCli(root, ["lint", "--format", "json"]);
      const l = liveOf(root);
      l.graph = parseGraph(graph.stdout);
      l.lint = parseLint(lint.stdout);
      if (graph.error && !l.graph.size && !cliWarned.has(k)) {
        cliWarned.add(k);
        output.appendLine(`openarc graph failed in ${root.fsPath} (stale regions are not shown): ${graph.stderr.trim().split("\n")[0] ?? graph.error.message}`);
      }
      scheduleRefresh();
    }
  } finally {
    cliBusy = false;
  }
}

// ── navigation, lenses ──────────────────────────────────────────────────────

const markerLocation = (f: FileInfo, r: Region) => new vscode.Location(f.uri, pos(f, r.begin.idStart));
const specLocation = (f: FileInfo, s: Spec) => new vscode.Location(f.uri, pos(f, s.idStart));

const definitions: vscode.DefinitionProvider = {
  provideDefinition(doc, position) {
    const file = files.get(uriKey(doc.uri));
    if (!file) return;
    const at = doc.offsetAt(position);
    const spec = file.parsed.specs.find((s) => at >= s.idStart && at <= s.idEnd);
    if (spec) {
      const hit = regionIndex.get(key(file.root, spec.id));
      return hit && markerLocation(hit.file, hit.region);
    }
    const marker = file.parsed.markers.find((m) => at >= m.idStart && at <= m.idEnd);
    const hit = marker && specIndex.get(key(file.root, marker.id));
    return hit && specLocation(hit.file, hit.spec);
  },
};

function summary(root: vscode.Uri, id: string, spec?: Spec): string {
  const state = displayOf(root, id);
  const parts: string[] = [`OpenArc: ${state}`];
  if (spec) parts.push(spec.kind === "block" ? "verified via parent" : `${spec.examples} example${spec.examples === 1 ? "" : "s"}`);
  const prov = manifests.get(pathKey(root))?.[id]?.provenance;
  if ((state === "compiler" || state === "stale") && prov?.model) parts.push(prov.model, `${prov.attempts ?? "?"} attempt${prov.attempts === 1 ? "" : "s"}`);
  const fail = failureOf(root, id);
  if (fail) parts.push(`last compile failed: ${codeOf(fail) ?? fail}`);
  return parts.join(" | ");
}

const lenses: vscode.CodeLensProvider = {
  onDidChangeCodeLenses: lensChanged.event,
  provideCodeLenses(doc) {
    const file = files.get(uriKey(doc.uri));
    if (!file) return [];
    const out: vscode.CodeLens[] = [];
    const lens = (line: number, title: string, command = "", args: unknown[] = []) =>
      out.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command, arguments: args }));
    for (const s of file.parsed.specs) {
      lens(s.line, summary(file.root, s.id, s));
      const hit = regionIndex.get(key(file.root, s.id));
      if (hit) lens(s.line, "Go to implementation", "openarc.goto", [markerLocation(hit.file, hit.region)]);
      lens(s.line, "Compile region", "openarc.compile", [file.root, s.id]);
    }
    for (const r of file.parsed.regions) {
      const hit = specIndex.get(key(file.root, r.id));
      if (hit) lens(r.begin.line, "Go to spec", "openarc.goto", [specLocation(hit.file, hit.spec)]);
      lens(r.begin.line, "Peek spec and attempts", "openarc.peek", [file.root, r.id]);
      lens(r.begin.line, summary(file.root, r.id, hit?.spec));
    }
    return out;
  },
};

// ── live status: status bar and the "OpenArc" view ──────────────────────────

type Node = vscode.TreeItem & { children?: Node[]; root?: vscode.Uri; regionId?: string };
let statusNodes: Node[] = [];

function regionNode(root: vscode.Uri, id: string, icon: string, description?: string, tooltip?: string): Node {
  const n: Node = Object.assign(new vscode.TreeItem(id), { root, regionId: id, description, tooltip, contextValue: "region", iconPath: new vscode.ThemeIcon(icon) });
  const r = regionIndex.get(key(root, id)), s = specIndex.get(key(root, id));
  const loc = r ? markerLocation(r.file, r.region) : s && specLocation(s.file, s.spec);
  if (loc) n.command = { title: "Go to region", command: "openarc.goto", arguments: [loc] };
  return n;
}

/** The function region a block belongs to: watch compiles blocks through their enclosing function (§15). */
function functionOf(root: vscode.Uri, id: string): string {
  for (let r = regionIndex.get(key(root, id)); r?.region.parent && specIndex.get(key(root, r.region.id))?.spec.kind === "block"; r = regionIndex.get(key(root, r.region.parent))) id = r.region.parent;
  return id;
}

function buildStatus() {
  const running: Node[] = [], pending: Node[] = [], failed: Node[] = [];
  for (const root of roots) {
    const where = roots.length > 1 ? vscode.workspace.asRelativePath(root) : undefined;
    const l = liveOf(root);
    // ponytail: a "running" record left by a killed watch shows until the next `openarc watch` marks it interrupted.
    const run = new Set([...l.history.values()].filter((e) => e.state === "running").map((e) => e.id));
    for (const id of run) running.push(regionNode(root, id, "sync~spin", where, `compiling since ${l.history.get(id)!.at}`));
    const ids = [...regionIndex.keys()].filter((k) => k.startsWith(pathKey(root) + "\0")).map((k) => k.split("\0")[1]);
    const todo = new Set<string>();
    for (const id of ids) {
      const fail = failureOf(root, id);
      if (fail) failed.push(regionNode(root, id, "error", fail, failureMessage(fail)));
      else if (["pending", "stale"].includes(displayOf(root, id))) todo.add(functionOf(root, id));
    }
    for (const id of [...todo].sort()) if (!run.has(id) && !failureOf(root, id)) pending.push(regionNode(root, id, "circle-outline", [displayOf(root, id), where].filter(Boolean).join(" · ")));
  }
  const group = (label: string, icon: string, children: Node[], tooltip: string): Node =>
    Object.assign(new vscode.TreeItem(label, children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None),
      { children, description: String(children.length), iconPath: new vscode.ThemeIcon(icon), tooltip });
  statusNodes = [
    group("Compiling", "sync", running, "the region `openarc watch` is compiling now (.openarc/watch-history.jsonl)"),
    group("Pending", "clock", pending, "pending or stale regions that have not failed since: what `openarc watch` will compile"),
    group("Failed", "error", failed, "the last compile of these regions failed (watch history, .openarc/failed.json)"),
  ];
  treeChanged.fire();
  if (!roots.length) return statusItem.hide();
  statusItem.text = running.length ? `$(sync~spin) OpenArc: ${running.map((n) => n.label).join(", ")}`
    : failed.length ? `$(error) OpenArc: ${failed.length} failed`
    : pending.length ? `$(clock) OpenArc: ${pending.length} pending` : "$(check) OpenArc";
  statusItem.tooltip = `${running.length} compiling, ${pending.length} pending, ${failed.length} failed`;
  statusItem.show();
}

const statusTree: vscode.TreeDataProvider<Node> = {
  onDidChangeTreeData: treeChanged.event,
  getTreeItem: (n) => n,
  getChildren: (n) => (n ? n.children ?? [] : statusNodes),
};

// ── commands ────────────────────────────────────────────────────────────────

async function pickRoot(): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor && rootOf(vscode.window.activeTextEditor.document.uri);
  if (active || roots.length <= 1) return active ?? roots[0];
  const pick = await vscode.window.showQuickPick(roots.map((r) => ({ label: vscode.workspace.asRelativePath(r), root: r })), { placeHolder: "OpenArc project" });
  return pick?.root;
}

/** The innermost region under the cursor, or the spec on the cursor's line, if it is in this project. */
function idAtCursor(root: vscode.Uri): string | undefined {
  const ed = vscode.window.activeTextEditor;
  const file = ed && files.get(uriKey(ed.document.uri));
  if (!ed || !file || !sameRoot(file.root, root)) return;
  const line = ed.selection.active.line;
  const inner = file.parsed.regions.filter((r) => r.begin.line <= line && line <= r.end.line)
    .sort((a, b) => (a.end.line - a.begin.line) - (b.end.line - b.begin.line))[0];
  return inner?.id ?? file.parsed.specs.find((s) => s.line === line)?.id;
}

async function pickId(root: vscode.Uri, verb: string): Promise<string | undefined> {
  const here = idAtCursor(root);
  if (here) return here;
  const ids = [...specIndex.keys()].filter((k) => k.startsWith(pathKey(root) + "\0")).map((k) => k.split("\0")[1]).sort();
  return vscode.window.showQuickPick(ids.map((id) => ({ label: id, description: displayOf(root, id) })), { placeHolder: `Region to ${verb}` })
    .then((p) => p?.label);
}

const valid = (id: unknown): id is string => typeof id === "string" && ID.test(id); // ids reach a shell
const invalid = (what: string, v: string) => void vscode.window.showErrorMessage(`OpenArc: invalid ${what} '${v}'`);

function ownership(verb: "release" | "freeze") {
  return async (root?: vscode.Uri, id?: string) => {
    root ??= await pickRoot();
    if (!root) return;
    id ??= await pickId(root, verb);
    if (valid(id)) toOutput(root, [verb, id]);
    else if (id !== undefined) invalid("region id", id);
  };
}

async function backendsTest() {
  const root = await pickRoot();
  if (!root) return;
  let names: string[] = [];
  try { names = Object.keys(JSON.parse((await readText(vscode.Uri.joinPath(root, "openarc.config.json"))) ?? "{}").backends ?? {}); } catch { /* the CLI reports it */ }
  const name = names.length > 1 ? await vscode.window.showQuickPick(["(default)", ...names], { placeHolder: "Backend to test (sends one tiny request)" }) : "(default)";
  if (name === undefined) return;
  if (name !== "(default)" && !safeArg(name)) return invalid("backend name", name);
  toOutput(root, ["backends", "test", ...(name === "(default)" ? [] : [name])]);
}

async function extract() {
  const doc = vscode.window.activeTextEditor?.document;
  const root = doc && rootOf(doc.uri);
  if (!doc || !root) return void vscode.window.showErrorMessage("OpenArc: open a TypeScript file of an OpenArc project to extract from");
  const rel = doc.uri.path.slice(root.path.length + 1);
  if (!safeArg(rel)) return invalid("file path (spaces are not supported)", rel);
  const fn = await vscode.window.showInputBox({ prompt: `Extract from ${rel}: function name, or empty for every function`, placeHolder: "functionName" });
  if (fn === undefined) return;
  if (fn && !/^[A-Za-z_$][\w$]*$/.test(fn)) return invalid("function name", fn);
  if (doc.isDirty) await doc.save();
  toOutput(root, ["extract", rel, ...(fn ? ["--function", fn] : [])]);
}

async function checkOracle() {
  const root = await pickRoot();
  if (!root) return;
  const id = await pickId(root, "check against an oracle");
  if (id === undefined) return;
  if (!valid(id)) return invalid("region id", id);
  const oracle = await vscode.window.showInputBox({ prompt: `Reference implementation for ${id}`, placeHolder: "<module>#<export>, e.g. ./reference.ts#add" });
  if (!oracle) return;
  if (!safeArg(oracle) || !oracle.includes("#")) return invalid("oracle (expected <module>#<export>)", oracle);
  toOutput(root, ["check", id, "--oracle", oracle]);
}

/** Failed attempts, newest first, each pointing at its body (or raw output) line in .openarc/attempts/<id>/<n>.json. */
async function attemptLocations(root: vscode.Uri, id: string): Promise<vscode.Location[]> {
  const dir = vscode.Uri.joinPath(root, ".openarc", "attempts", id);
  let names: string[] = [];
  try { names = (await vscode.workspace.fs.readDirectory(dir)).map(([n]) => n).filter((n) => /^\d+\.json$/.test(n)); } catch { return []; }
  names.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  return Promise.all(names.map(async (n) => {
    const uri = vscode.Uri.joinPath(dir, n);
    const line = Math.max(0, ((await readText(uri)) ?? "").split("\n").findIndex((l) => /^\s*"(body|raw)":/.test(l)));
    return new vscode.Location(uri, new vscode.Range(line, 0, line, 0));
  }));
}

/** Peek: the region's body, its spec and its failed attempts, side by side in one peek widget. */
async function peek(arg?: vscode.Uri | Node, idArg?: string) {
  const fromTree = arg && "regionId" in arg;
  let root = fromTree ? (arg as Node).root : (arg as vscode.Uri | undefined);
  root ??= await pickRoot();
  if (!root) return;
  const id = fromTree ? (arg as Node).regionId : idArg ?? await pickId(root, "peek");
  if (!id) return;
  const r = regionIndex.get(key(root, id)), s = specIndex.get(key(root, id));
  const locs: vscode.Location[] = [];
  if (r) locs.push(new vscode.Location(r.file.uri, new vscode.Range(r.region.begin.line, 0, r.region.end.line + 1, 0)));
  if (s) locs.push(specLocation(s.file, s.spec));
  locs.push(...await attemptLocations(root, id));
  // anchor at the cursor when it is on this region/spec, else at the begin marker (or the spec)
  const ed = vscode.window.activeTextEditor;
  const anchor = ed && !fromTree && idAtCursor(root) === id ? new vscode.Location(ed.document.uri, ed.selection.active)
    : r ? markerLocation(r.file, r.region) : s && specLocation(s.file, s.spec);
  if (!anchor) return void vscode.window.showErrorMessage(`OpenArc: no region or spec '${id}'`);
  await vscode.window.showTextDocument(anchor.uri, { selection: new vscode.Range(anchor.range.start, anchor.range.start) });
  await vscode.commands.executeCommand("editor.action.peekLocations", anchor.uri, anchor.range.start, locs, "peek");
}

// ── activation ──────────────────────────────────────────────────────────────

export async function activate(ctx: vscode.ExtensionContext) {
  const loadMs = Math.round(performance.now() - t0);
  diagnostics = vscode.languages.createDiagnosticCollection("openarc");
  output = vscode.window.createOutputChannel("OpenArc");
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusItem.command = "openarc.status.focus";
  const selector: vscode.DocumentSelector = [{ language: "typescript", scheme: "file" }, { language: "typescriptreact", scheme: "file" }];
  const tsWatcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx}");
  // what the CLI writes: the manifest, the watch history and the regions whose attempts were exhausted
  const stateWatcher = vscode.workspace.createFileSystemWatcher("**/.openarc/{manifest.json,watch-history.jsonl,failed.json}");
  const configWatcher = vscode.workspace.createFileSystemWatcher("**/openarc.config.json", false, true, false);
  const onState = async (uri: vscode.Uri) => {
    const root = roots.find((r) => sameRoot(r, vscode.Uri.joinPath(uri, "..", "..")));
    if (!root) return;
    if (uri.path.endsWith("/manifest.json")) { await loadManifest(root); scheduleAnalysis(root); } else await loadLive(root);
    scheduleRefresh();
  };
  const onTs = async (uri: vscode.Uri) => {
    if (uri.path.includes("/node_modules/") || uri.path.endsWith(".d.ts")) return;
    await readFromDisk(uri);
    scheduleRefresh();
  };

  ctx.subscriptions.push(
    diagnostics, output, statusItem, lensChanged, treeChanged, tsWatcher, stateWatcher, configWatcher, ...tints.values(),
    vscode.languages.registerDefinitionProvider(selector, definitions),
    vscode.languages.registerCodeLensProvider(selector, lenses),
    vscode.window.registerTreeDataProvider("openarc.status", statusTree),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (files.has(uriKey(e.document.uri)) || rootOf(e.document.uri) && e.document.languageId.startsWith("typescript")) {
        setFile(e.document.uri, e.document.getText());
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((d) => { const r = files.get(uriKey(d.uri))?.root; if (r) scheduleAnalysis(r); }),
    vscode.workspace.onDidCloseTextDocument((d) => { if (files.has(uriKey(d.uri))) onTs(d.uri); }), // drop unsaved edits
    vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(decorate)),
    tsWatcher.onDidChange(onTs), tsWatcher.onDidCreate(onTs),
    tsWatcher.onDidDelete((uri) => { files.delete(uriKey(uri)); scheduleRefresh(); }),
    stateWatcher.onDidChange(onState), stateWatcher.onDidCreate(onState), stateWatcher.onDidDelete(onState),
    configWatcher.onDidCreate(discover), configWatcher.onDidDelete(discover), // a project appeared or went away
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("openarc.cliPath")) { cliWarned.clear(); roots.forEach(scheduleAnalysis); } }),
    vscode.commands.registerCommand("openarc.goto", (loc: vscode.Location) =>
      vscode.window.showTextDocument(loc.uri, { selection: new vscode.Range(loc.range.start, loc.range.start) })),
    vscode.commands.registerCommand("openarc.compile", async (root?: vscode.Uri, id?: string) => {
      if (id !== undefined && !valid(id)) return invalid("region id", id);
      root ??= await pickRoot();
      if (root) inTerminal(root, ["compile", ...(id ? [id] : [])]);
    }),
    vscode.commands.registerCommand("openarc.watch", async () => {
      const root = await pickRoot();
      if (root) inTerminal(root, ["watch"], "OpenArc watch"); // its own terminal: compile must not type into it
    }),
    vscode.commands.registerCommand("openarc.graph", async () => {
      const root = await pickRoot();
      if (root) toOutput(root, ["graph"]);
    }),
    vscode.commands.registerCommand("openarc.release", ownership("release")),
    vscode.commands.registerCommand("openarc.freeze", ownership("freeze")),
    vscode.commands.registerCommand("openarc.backendsTest", backendsTest),
    vscode.commands.registerCommand("openarc.extract", extract),
    vscode.commands.registerCommand("openarc.checkOracle", checkOracle),
    vscode.commands.registerCommand("openarc.doctor", async () => {
      const root = await pickRoot();
      if (root) toOutput(root, ["doctor"]);
    }),
    vscode.commands.registerCommand("openarc.peek", peek),
  );

  await discover();
  const activationMs = Math.round(performance.now() - t0);
  output.appendLine(`activated in ${activationMs} ms (${loadMs} ms loading, the rest indexing ${files.size} file(s) in ${roots.length} project(s))`);
  // for the integration tests
  return { activationMs, loadMs, status: () => statusNodes, statusText: () => statusItem.text };
}

/** Find every project root (deepest first, so a nested project wins) and re-index from scratch. */
async function discover() {
  roots = (await vscode.workspace.findFiles("**/openarc.config.json", "**/node_modules/**"))
    .map((u) => vscode.Uri.joinPath(u, "..")).sort((a, b) => b.path.length - a.path.length);
  manifests.clear();
  live.clear();
  files.clear();
  vscode.commands.executeCommand("setContext", "openarc.hasProject", roots.length > 0);
  await Promise.all(roots.flatMap((r) => [loadManifest(r), loadLive(r)]));
  const tsFiles = (await vscode.workspace.findFiles("**/*.{ts,tsx}", TS_EXCLUDE)).filter((u) => { const r = rootOf(u); return r && inSrc(u, r); });
  await Promise.all(tsFiles.map(readFromDisk));
  refresh();
  roots.forEach(scheduleAnalysis); // after activation: the CLI is never on the activation path
}

export function deactivate() {}
