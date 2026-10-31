// `openarc migrate <id>` (SPEC §14): turn one classic function region (defineRegion + `export const s: F = …` between
// markers) into a code-first declaration, in one transaction. HAND-WRITTEN bootstrap code, not a region.
//   export const s: F = (a, b) => { … }   becomes   /** intent  @arc id <id> */ export function s(a: A, b: B): R { …markers… }
// The intent becomes the JSDoc; examples, calls, effects, deps and tolerance move to `arc.configure(s, {…})` (lossless);
// the defineRegion statement goes (its type alias stays). The id, ownership and provenance are kept; the new owned text's
// hash and spec hash are recorded in the manifest, so the move is not seen as a hand edit or a spec change.
import ts from "typescript";
import type { Json } from "open-arc";
import type { CompileRequest, Diagnostic, Ports, StagedFile } from "./types.ts";
import * as engine from "./engine.ts";

const errorsOf = (prog: ts.Program, sf: ts.SourceFile) =>
  [...prog.getSyntacticDiagnostics(sf), ...prog.getSemanticDiagnostics(sf)].filter((d) => d.category === ts.DiagnosticCategory.Error).map((d) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);

export async function migrate(ports: Ports, req: CompileRequest, p: engine.Project, id: string): Promise<{ files: StagedFile[]; refused?: string }> {
  const no = (refused: string) => ({ files: [], refused });
  const ds: Diagnostic[] = [];
  await engine.analyze(ports, req, p, ds, { offline: true });
  const r = p.regions.find((x) => x.id === id);
  if (!r || r.kind !== "function") return no(`no function region ${id}`);
  const s = r.spec;
  if (s.codeFirst) return no(`${id} is code-first already`);
  if (s.sketch || s.ui || s.literal.concept !== undefined) return no(`${id} has a sketch, a ui structure or a concept: those stay defineRegion specs`);
  if (r.childSpans.length) return no(`${id} has block regions: migrate them by hand (their parent's shape changes)`);
  if (r.state === "conflicted") return no(`${id} is conflicted: openarc resolve it first`);
  const checker = p.program!.getTypeChecker();
  const text = p.disk.get(r.file)!.replace(/\r\n/g, "\n");
  if ((p.files.get(r.file) ?? "") !== text) return no(`${r.file} has pending regions scaffolded in memory: run openarc scaffold first`);
  const elsewhere = [...p.files].some(([rel, t]) => rel !== r.file && new RegExp(`\\b${s.exportName}\\b`).test(t));
  if (elsewhere) return no(`${s.exportName} is used outside ${r.file}`);

  // the declaration between the markers: `export const s: F = (…) => …`
  const sf = ts.createSourceFile("m.ts", r.bodyLines.join("\n"), ts.ScriptTarget.Latest, true);
  const st = sf.statements[0];
  const init = st && ts.isVariableStatement(st) && st.declarationList.declarations.length === 1 ? st.declarationList.declarations[0]!.initializer : undefined;
  const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
  const sig = s.typeNode ? checker.getTypeFromTypeNode(s.typeNode).getCallSignatures()[0] : undefined;
  if (!fn || !sig || sf.statements.length !== 1) return no(`${id}: the region is not a single \`export const ${s.symbol}: F = (…) => …\``);
  const show = (t: ts.Type) => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType);
  const params = fn.parameters.map((x, i) => {
    const ps = sig.getParameters()[i];
    return `${x.name.getText(sf)}${x.questionToken ? "?" : ""}: ${ps ? show(checker.getTypeOfSymbol(ps)) : "unknown"}`;
  });
  const isAsync = !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  const exported = !!(st as ts.VariableStatement).modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const ind = r.indent;
  const body = ts.isBlock(fn.body)
    ? (() => {
        const lines = sf.text.slice(fn.body.getStart(sf) + 1, fn.body.end - 1).split("\n").filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1));
        const strip = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
        return lines.map((l) => (l.trim() ? `${ind}  ${l.slice(strip)}` : ""));
      })()
    : [`${ind}  return ${fn.body.getText(sf)};`];
  const intent = s.intent.split(/(?<=\.)\s+/).filter(Boolean);
  const decl = [
    `${ind}/**`, ...intent.map((l) => `${ind} * ${l}`), `${ind} * @arc id ${id}`, `${ind} */`,
    `${ind}${exported ? "export " : ""}${isAsync ? "async " : ""}function ${s.symbol}(${params.join(", ")}): ${show(sig.getReturnType())} {`,
    `${ind}  // @openarc:begin ${id}`, ...body, `${ind}  // @openarc:end ${id}`, `${ind}}`,
  ];
  const cfg: Record<string, Json> = {};
  for (const k of ["calls", "effects", "deps", "tolerance", "examples"]) if (s.literal[k] !== undefined && !(Array.isArray(s.literal[k]) && k !== "calls" && (s.literal[k] as Json[]).length === 0)) cfg[k] = s.literal[k]!;

  // rewrite: the marked declaration becomes the function (+ arc.configure); the defineRegion statement goes
  const file = ts.createSourceFile(r.file, text, ts.ScriptTarget.Latest, true);
  const specSt = file.statements.find((x) => ts.isVariableStatement(x) && x.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === s.exportName))!;
  const lines = text.split("\n");
  const node = (() => {
    const begin = lines.findIndex((l) => l.trim() === `// @openarc:begin ${id}`);
    return { begin, end: lines.findIndex((l, i) => i > begin && l.trim() === `// @openarc:end ${id}`) };
  })();
  const configure = Object.keys(cfg).length ? ["", `${ind}arc.configure(${s.symbol}, ${JSON.stringify(cfg)});`] : [];
  lines.splice(node.begin, node.end - node.begin + 1, ...decl, ...configure);
  const s0 = file.getLineAndCharacterOfPosition(specSt.getStart(file, true)).line, s1 = file.getLineAndCharacterOfPosition(specSt.end).line;
  if (s1 >= node.begin) return no(`${id}: its defineRegion statement must come before its markers`);
  lines.splice(s0, s1 - s0 + 1 + (lines[s1 + 1]?.trim() === "" ? 1 : 0));
  const out = lines.join("\n");

  // the result must type-check no worse than before and analyze as the same region, code-first
  const before = errorsOf(p.program!, p.program!.getSourceFile(`${p.root}/${r.file}`)!);
  const q = await engine.parse(ports, req, []);
  q.files.set(r.file, out);
  const ds2: Diagnostic[] = [];
  await engine.analyze(ports, req, q, ds2, { offline: true });
  const after = errorsOf(q.program!, q.program!.getSourceFile(`${q.root}/${r.file}`)!).filter((e) => !before.includes(e));
  const r2 = q.regions.find((x) => x.id === id);
  const bad = ds2.filter((d) => d.code.startsWith("OARC-E") && d.file === r.file && !ds.some((x) => x.code === d.code && x.id === d.id));
  if (after.length || bad.length || !r2?.spec.codeFirst) return no(`the migrated file would not check: ${after[0] ?? bad.map((d) => `${d.code} ${d.id ?? ""}`).join(", ") ?? "not a code-first region"}`);
  const manifest = JSON.parse(JSON.stringify(p.manifest)) as engine.Manifest;
  const old = manifest.regions[id];
  if (old) manifest.regions[id] = { ...old, symbol: s.symbol, declaration: r2.spec.codeFirst.declaration, hash: r2.hash, specHash: r2.specHash, provenance: { ...old.provenance, migrated: ports.now() } };
  return { files: [{ target: r.file, text: engine.toDisk(p, r.file, out) }, ...(old ? [{ target: ".openarc/manifest.json", text: JSON.stringify(manifest, null, 2) + "\n" }] : [])] };
}
