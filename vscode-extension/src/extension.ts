import * as vscode from "vscode";
import { execFile } from "child_process";
import { parse, positionAt, Parsed, Region, Spec } from "./parse";

type State = "pending" | "compiler" | "developer" | "conflicted";
interface Entry { ownership: State; provenance?: { model?: string; attempts?: number; contextLevel?: number; verifiedBy?: string[] } }
interface FileInfo { uri: vscode.Uri; root: vscode.Uri; parsed: Parsed }

const ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
const TS_EXCLUDE = "{**/node_modules/**,**/.openarc/**,**/*.d.ts}";

let roots: vscode.Uri[] = []; // folders holding openarc.config.json, deepest first
const manifests = new Map<string, Record<string, Entry>>(); // root.path -> regions
const files = new Map<string, FileInfo>(); // uri.toString() -> parsed file
let specIndex = new Map<string, { file: FileInfo; spec: Spec }>(); // root.path + "\0" + id
let regionIndex = new Map<string, { file: FileInfo; region: Region }>();

const lensChanged = new vscode.EventEmitter<void>();
const STATES: State[] = ["pending", "compiler", "developer", "conflicted"];
const tints = new Map(STATES.map((s) => [s, vscode.window.createTextEditorDecorationType({
  isWholeLine: true, backgroundColor: new vscode.ThemeColor(`openarc.${s}Background`),
})]));
let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;

const key = (root: vscode.Uri, id: string) => `${root.path}\0${id}`;
const rootOf = (uri: vscode.Uri) => roots.find((r) => uri.path.startsWith(r.path + "/"));
// The CLI reads specs and markers only under <root>/src/ (engine srcFiles); other files never enter the index.
const inSrc = (uri: vscode.Uri, root: vscode.Uri) => uri.path.startsWith(root.path + "/src/");
const pos = (f: FileInfo, offset: number) => { const p = positionAt(f.parsed.lineStarts, offset); return new vscode.Position(p.line, p.character); };
const range = (f: FileInfo, start: number, end: number) => new vscode.Range(pos(f, start), pos(f, end));

function stateOf(root: vscode.Uri, id: string): State {
  const entry = manifests.get(root.path)?.[id];
  if (entry) return entry.ownership;
  const r = regionIndex.get(key(root, id))?.region;
  return !r || r.placeholder ? "pending" : "developer"; // §6.2: no entry -> pending if placeholder, else extracted
}

// ── indexing ────────────────────────────────────────────────────────────────

async function loadManifest(root: vscode.Uri, retries = 3): Promise<void> {
  let raw: string;
  try {
    raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ".openarc", "manifest.json")));
  } catch {
    manifests.set(root.path, {}); // no manifest: every region falls back to §6.2
    return;
  }
  try {
    manifests.set(root.path, JSON.parse(raw).regions ?? {});
  } catch { // caught mid-write: keep the previous state and read again shortly
    if (retries > 0) setTimeout(() => loadManifest(root, retries - 1).then(scheduleRefresh), 300);
  }
}

function setFile(uri: vscode.Uri, text: string) {
  const root = rootOf(uri);
  if (root && inSrc(uri, root)) files.set(uri.toString(), { uri, root, parsed: parse(text, uri.path) });
}

async function readFromDisk(uri: vscode.Uri) {
  const openText = () => vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())?.getText();
  let text = openText();
  if (text === undefined) {
    try { text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { files.delete(uri.toString()); return; }
    text = openText() ?? text; // opened and edited while we were reading: the editor text is newer
  }
  setFile(uri, text);
}

let timer: unknown;
function scheduleRefresh() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 150);
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
  const broken = new Set([...files.values()].filter((f) => f.parsed.problems.some((p) => p.code === "OARC-E030" || p.code === "OARC-E031")).map((f) => f.root.path));
  for (const file of files.values()) {
    const ds = file.parsed.problems.map((p) => {
      const d = new vscode.Diagnostic(range(file, p.start, p.end), p.message,
        p.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = "openarc";
      return d;
    });
    for (const m of file.parsed.markers) {
      if (m.kind === "begin" && !specIndex.has(key(file.root, m.id))) {
        ds.push(Object.assign(new vscode.Diagnostic(range(file, m.idStart, m.idEnd),
          `OARC-E012: no defineRegion/defineBlock spec with id '${m.id}'`, vscode.DiagnosticSeverity.Error), { source: "openarc" }));
      }
    }
    for (const s of file.parsed.specs) {
      if (!broken.has(file.root.path) && !regionIndex.has(key(file.root, s.id))) {
        ds.push(Object.assign(new vscode.Diagnostic(range(file, s.idStart, s.idEnd),
          `'${s.id}' has no markers yet: run openarc scaffold`, vscode.DiagnosticSeverity.Information), { source: "openarc" }));
      }
    }
    if (ds.length) diagnostics.set(file.uri, ds);
  }
  lensChanged.fire();
  vscode.window.visibleTextEditors.forEach(decorate);
}

function decorate(editor: vscode.TextEditor) {
  const file = files.get(editor.document.uri.toString());
  for (const s of STATES) {
    const ranges = file?.parsed.regions.filter((r) => stateOf(file.root, r.id) === s)
      .map((r) => new vscode.Range(r.begin.line, 0, r.end.line, 0)) ?? [];
    editor.setDecorations(tints.get(s)!, ranges);
  }
}

// ── navigation, lenses ──────────────────────────────────────────────────────

const markerLocation = (f: FileInfo, r: Region) => new vscode.Location(f.uri, pos(f, r.begin.idStart));
const specLocation = (f: FileInfo, s: Spec) => new vscode.Location(f.uri, pos(f, s.idStart));

const definitions: vscode.DefinitionProvider = {
  provideDefinition(doc, position) {
    const file = files.get(doc.uri.toString());
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
  const state = stateOf(root, id);
  const parts: string[] = [`OpenArc: ${state}`];
  if (spec) parts.push(spec.kind === "block" ? "verified via parent" : `${spec.examples} example${spec.examples === 1 ? "" : "s"}`);
  const prov = manifests.get(root.path)?.[id]?.provenance;
  if (state === "compiler" && prov?.model) parts.push(prov.model, `${prov.attempts ?? "?"} attempt${prov.attempts === 1 ? "" : "s"}`);
  return parts.join(" | ");
}

const lenses: vscode.CodeLensProvider = {
  onDidChangeCodeLenses: lensChanged.event,
  provideCodeLenses(doc) {
    const file = files.get(doc.uri.toString());
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
      lens(r.begin.line, summary(file.root, r.id, hit?.spec));
    }
    return out;
  },
};

// ── commands ────────────────────────────────────────────────────────────────

async function pickRoot(): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor && rootOf(vscode.window.activeTextEditor.document.uri);
  if (active || roots.length <= 1) return active ?? roots[0];
  const pick = await vscode.window.showQuickPick(roots.map((r) => ({ label: vscode.workspace.asRelativePath(r), root: r })), { placeHolder: "OpenArc project" });
  return pick?.root;
}

async function pickId(root: vscode.Uri, verb: string): Promise<string | undefined> {
  const ed = vscode.window.activeTextEditor;
  const file = ed && files.get(ed.document.uri.toString());
  if (ed && file && file.root.path === root.path) { // innermost region under the cursor, if it is in this project
    const line = ed.selection.active.line;
    const inner = file.parsed.regions.filter((r) => r.begin.line <= line && line <= r.end.line)
      .sort((a, b) => (a.end.line - a.begin.line) - (b.end.line - b.begin.line))[0];
    if (inner) return inner.id;
  }
  const ids = [...specIndex.keys()].filter((k) => k.startsWith(root.path + "\0")).map((k) => k.split("\0")[1]).sort();
  return vscode.window.showQuickPick(ids.map((id) => ({ label: id, description: stateOf(root, id) })), { placeHolder: `Region to ${verb}` })
    .then((p) => p?.label);
}

function inTerminal(root: vscode.Uri, args: string[]) {
  const name = `OpenArc: ${vscode.workspace.asRelativePath(root)}`;
  const term = vscode.window.terminals.find((t) => t.name === name && t.exitStatus === undefined)
    ?? vscode.window.createTerminal({ name, cwd: root });
  term.show();
  // A reused terminal may have been cd'ed elsewhere. ponytail: plain `cd` (no `/d`), so cmd.exe cannot switch drives.
  if (!root.fsPath.includes('"')) term.sendText(`cd "${root.fsPath}"`);
  term.sendText(["npx", "openarc", ...args].join(" "));
}

function toOutput(root: vscode.Uri, args: string[]) {
  output.show(true);
  output.appendLine(`$ npx openarc ${args.join(" ")}   (${root.fsPath})`);
  execFile("npx", ["openarc", ...args], { cwd: root.fsPath, shell: process.platform === "win32" }, (err, stdout, stderr) => {
    if (stdout) output.append(stdout);
    if (stderr) output.append(stderr);
    if (err) output.appendLine(`[failed] ${err.message}`);
  });
}

const valid = (id: unknown): id is string => typeof id === "string" && ID.test(id); // ids reach a shell

function ownership(verb: "release" | "freeze") {
  return async (root?: vscode.Uri, id?: string) => {
    root ??= await pickRoot();
    if (!root) return;
    id ??= await pickId(root, verb);
    if (valid(id)) toOutput(root, [verb, id]);
    else if (id !== undefined) vscode.window.showErrorMessage(`OpenArc: invalid region id '${id}'`);
  };
}

// ── activation ──────────────────────────────────────────────────────────────

export async function activate(ctx: vscode.ExtensionContext) {
  diagnostics = vscode.languages.createDiagnosticCollection("openarc");
  output = vscode.window.createOutputChannel("OpenArc");
  const selector: vscode.DocumentSelector = [{ language: "typescript", scheme: "file" }, { language: "typescriptreact", scheme: "file" }];
  const tsWatcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,tsx}");
  const manifestWatcher = vscode.workspace.createFileSystemWatcher("**/.openarc/manifest.json");
  const configWatcher = vscode.workspace.createFileSystemWatcher("**/openarc.config.json", false, true, false);
  const onManifest = async (uri: vscode.Uri) => {
    const root = vscode.Uri.joinPath(uri, "..", "..");
    if (roots.some((r) => r.path === root.path)) { await loadManifest(root); scheduleRefresh(); }
  };
  const onTs = async (uri: vscode.Uri) => {
    if (uri.path.includes("/node_modules/") || uri.path.endsWith(".d.ts")) return;
    await readFromDisk(uri);
    scheduleRefresh();
  };

  ctx.subscriptions.push(
    diagnostics, output, lensChanged, tsWatcher, manifestWatcher, configWatcher, ...tints.values(),
    vscode.languages.registerDefinitionProvider(selector, definitions),
    vscode.languages.registerCodeLensProvider(selector, lenses),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (files.has(e.document.uri.toString()) || rootOf(e.document.uri) && e.document.languageId.startsWith("typescript")) {
        setFile(e.document.uri, e.document.getText());
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((d) => { if (files.has(d.uri.toString())) onTs(d.uri); }), // drop unsaved edits
    vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach(decorate)),
    tsWatcher.onDidChange(onTs), tsWatcher.onDidCreate(onTs),
    tsWatcher.onDidDelete((uri) => { files.delete(uri.toString()); scheduleRefresh(); }),
    manifestWatcher.onDidChange(onManifest), manifestWatcher.onDidCreate(onManifest), manifestWatcher.onDidDelete(onManifest),
    configWatcher.onDidCreate(discover), configWatcher.onDidDelete(discover), // a project appeared or went away
    vscode.commands.registerCommand("openarc.goto", (loc: vscode.Location) =>
      vscode.window.showTextDocument(loc.uri, { selection: new vscode.Range(loc.range.start, loc.range.start) })),
    vscode.commands.registerCommand("openarc.compile", async (root?: vscode.Uri, id?: string) => {
      if (id !== undefined && !valid(id)) return void vscode.window.showErrorMessage(`OpenArc: invalid region id '${id}'`);
      root ??= await pickRoot();
      if (root) inTerminal(root, ["compile", ...(id ? [id] : [])]);
    }),
    vscode.commands.registerCommand("openarc.graph", async () => {
      const root = await pickRoot();
      if (root) toOutput(root, ["graph"]);
    }),
    vscode.commands.registerCommand("openarc.release", ownership("release")),
    vscode.commands.registerCommand("openarc.freeze", ownership("freeze")),
  );

  await discover();
}

/** Find every project root (deepest first, so a nested project wins) and re-index from scratch. */
async function discover() {
  roots = (await vscode.workspace.findFiles("**/openarc.config.json", "**/node_modules/**"))
    .map((u) => vscode.Uri.joinPath(u, "..")).sort((a, b) => b.path.length - a.path.length);
  manifests.clear();
  files.clear();
  await Promise.all(roots.map((r) => loadManifest(r)));
  const tsFiles = (await vscode.workspace.findFiles("**/*.{ts,tsx}", TS_EXCLUDE)).filter((u) => { const r = rootOf(u); return r && inSrc(u, r); });
  await Promise.all(tsFiles.map(readFromDisk));
  refresh();
}

export function deactivate() {}
