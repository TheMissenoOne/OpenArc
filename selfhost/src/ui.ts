// UI structure specs (SPEC §2.6): `ui: (props) => <Form …>…</Form>` in a `*.spec.tsx` file, read statically into a JSON
// tree; the region is a React component in the sibling `.tsx` file. HAND-WRITTEN bootstrap code, not a region.
// engine.ts calls it from marked hooks: extraction, scaffolding, the context package and the DOM-availability check.
// The DOM checks themselves run in the sandbox (core/ui-harness.ts).
import ts from "typescript";
import type { Json } from "open-arc";
import type { Diagnostic, Ports } from "./types.ts";

export type UiTree = { tag: string; props: { [k: string]: Json }; children: (UiTree | string)[] };
export interface UiInfo {
  param: string | null; // the ui arrow's parameter name ("props")
  root: UiTree;
}

/** The vocabulary (core/ui.ts) and the meaning of each word, as the model reads it. The harness checks these. */
export const MEANINGS: Record<string, string> = {
  Form: "Form: a <form> with a heading (h1-h3 or legend) showing `title`. On submit: preventDefault, then call onSubmit with { <Field name>: value } for every Field. A result with ok: false shows its `error` in ErrorText; ok: true calls onSuccess(result) when given.",
  Field: "Field: <label htmlFor=id>label</label> plus <input id name type required autoComplete>, so the label is the input's accessible name. secret means type=\"password\"; type defaults to \"text\".",
  ErrorText: "ErrorText: an element with role=\"alert\" holding the last failure message (empty when there is none).",
  Submit: "Submit: <button type=\"submit\"> named by its text. While onSubmit is pending it is disabled and shows busyText.",
};
export const VOCABULARY_VERSION = "1";

/** Read `ui: (props) => <…/>` (§2.6 static subset). Nothing is evaluated: elements of the vocabulary, text, JSON-literal
 *  attributes, bare attributes (true), and dotted references rooted at the parameter or an import ({"$ref": "props.onLogin"}). */
export function readUi(n: ts.Expression, sf: ts.SourceFile): UiInfo | { error: string } {
  if (!ts.isArrowFunction(n) || n.parameters.length > 1) return { error: "ui:must-be-(props)=>jsx" };
  const param = n.parameters[0] ? n.parameters[0].name.getText(sf) : null;
  const imports = new Set<string>();
  for (const st of sf.statements) {
    const c = ts.isImportDeclaration(st) ? st.importClause : undefined;
    if (!c || c.isTypeOnly) continue;
    if (c.name) imports.add(c.name.text);
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) imports.add(c.namedBindings.name.text);
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((e) => imports.add(e.name.text));
  }
  class Bad extends Error {}
  const json = (e: ts.Expression): Json => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isNumericLiteral(e)) return Number(e.text);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text);
    if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (e.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(e)) return e.elements.map(json);
    if (ts.isObjectLiteralExpression(e))
      return Object.fromEntries(e.properties.map((p) => {
        if (!ts.isPropertyAssignment(p) || ts.isComputedPropertyName(p.name)) throw new Bad(`ui:expression:${p.getText(sf).slice(0, 40).trim()}`);
        return [p.name.getText(sf).replace(/^["']|["']$/g, ""), json(p.initializer)];
      }));
    let x = e;
    const path: string[] = [];
    while (ts.isPropertyAccessExpression(x)) {
      path.unshift(x.name.text);
      x = x.expression;
    }
    if (ts.isIdentifier(x) && (x.text === param || imports.has(x.text))) return { $ref: [x.text, ...path].join(".") };
    throw new Bad(`ui:expression:${e.getText(sf).slice(0, 40).trim()}`);
  };
  const el = (x: ts.Node): UiTree | string | null => {
    if (ts.isJsxText(x)) return x.text.replace(/\s+/g, " ").trim() || null;
    if (ts.isJsxExpression(x)) {
      if (!x.expression) return null; // {/* comment */}
      if (ts.isStringLiteral(x.expression)) return x.expression.text;
      throw new Bad(`ui:child-expression:${x.expression.getText(sf).slice(0, 40).trim()}`);
    }
    if (ts.isJsxFragment(x)) return { tag: "Fragment", props: {}, children: kids(x.children) };
    const open = ts.isJsxElement(x) ? x.openingElement : ts.isJsxSelfClosingElement(x) ? x : null;
    if (!open) throw new Bad(`ui:not-jsx:${x.getText(sf).slice(0, 40).trim()}`);
    if (!ts.isIdentifier(open.tagName) || !Object.hasOwn(MEANINGS, open.tagName.text)) throw new Bad(`ui:tag:${open.tagName.getText(sf)}`);
    const props: { [k: string]: Json } = {};
    for (const a of open.attributes.properties) {
      if (ts.isJsxSpreadAttribute(a)) throw new Bad("ui:spread");
      const init = a.initializer;
      props[a.name.getText(sf)] = !init ? true : ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) && init.expression ? json(init.expression) : true;
    }
    return { tag: open.tagName.text, props, children: ts.isJsxElement(x) ? kids(x.children) : [] };
  };
  const kids = (cs: ts.NodeArray<ts.JsxChild>) => cs.map(el).filter((c): c is UiTree | string => c !== null);
  let body: ts.Node = n.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  try {
    const root = el(body);
    if (!root || typeof root === "string" || root.tag !== "Form") return { error: "ui:root-must-be-Form" };
    return { param, root };
  } catch (e) {
    if (e instanceof Bad) return { error: e.message };
    throw e;
  }
}

/** Every node of `t` with this tag, depth first. */
export const nodesOf = (t: UiTree, tag: string): UiTree[] => [...(t.tag === tag ? [t] : []), ...t.children.flatMap((c) => (typeof c === "string" ? [] : nodesOf(c, tag)))];

/** The tree printed back as TSX, for the context package. */
export function printUi(n: UiTree | string, d = 0): string {
  const pad = "  ".repeat(d);
  if (typeof n === "string") return `${pad}${n}`;
  const attrs = Object.entries(n.props).map(([k, v]) =>
    v === true ? k : typeof v === "string" ? `${k}=${JSON.stringify(v)}` : v && typeof v === "object" && "$ref" in v ? `${k}={${String(v.$ref)}}` : `${k}={${JSON.stringify(v)}}`);
  const open = `${pad}<${[n.tag, ...attrs].join(" ")}`;
  return n.children.length ? `${open}>\n${n.children.map((c) => printUi(c, d + 1)).join("\n")}\n${pad}</${n.tag}>` : `${open} />`;
}

/** Package sections for a UI region: the required structure and what its words mean. */
export function uiSections(s: { ui?: UiInfo }): [string, string][] {
  if (!s.ui) return [];
  const used = [...new Set(["Form", "Field", "ErrorText", "Submit"].filter((t) => nodesOf(s.ui!.root, t).length))];
  return [
    ["Structure (required; checked in the rendered DOM)", printUi(s.ui.root)],
    ["What the structure words mean", used.map((t) => MEANINGS[t]).join("\n")],
    ["UI rules", "Write the BODY of a React function component (react-jsx): hooks from \"react\" (import them, e.g. {\"from\": \"react\", \"names\": [\"useState\"]}), no other libraries. Elements are found by their accessible names, so every input needs its label."],
  ];
}

/** E010 detail when F isn't a type name the spec file exports: the component file imports F from there (scaffoldUi). */
export function uiTypeProblem(typeNode: ts.TypeNode | undefined, sf: ts.SourceFile, checker: ts.TypeChecker): string | null {
  const bad = "ui:F-must-be-an-exported-type-name";
  if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName) || typeNode.typeArguments) return bad;
  const mod = checker.getSymbolAtLocation(sf);
  const name = typeNode.typeName.text;
  return mod && checker.getExportsOfModule(mod).some((e) => e.name === name) ? null : bad;
}

/** The component file for a `X.spec.tsx` spec: `X.tsx`, next to it. */
export const componentFile = (specFile: string): string | null => (/\.spec\.tsx$/.test(specFile) ? specFile.replace(/\.spec\.tsx$/, ".tsx") : null);

/** Scaffold a UI region into its component file (created when missing): markers and the pending placeholder, after an
 *  `import type` of F's type name from the spec file. */
export function scaffoldUi(files: Map<string, string>, s: { id: string; file: string; symbol: string; typeText: string; params: string[] }): Diagnostic | null {
  const target = componentFile(s.file);
  if (!target) return { code: "OARC-E010", id: s.id, file: s.file, detail: "ui:spec-file-must-end-in-.spec.tsx" };
  if (!/^[A-Za-z_$][\w$]*$/.test(s.typeText)) return { code: "OARC-E010", id: s.id, file: s.file, detail: "ui:F-must-be-an-exported-type-name" };
  const spec = `./${s.file.split("/").at(-1)}`;
  const lines = [`// @openarc:begin ${s.id}`, `export const ${s.symbol}: ${s.typeText} = (${s.params.join(", ")}) => arc.todo("${s.id}");`, `// @openarc:end ${s.id}`];
  const head = [`import * as arc from "open-arc";`, `import type { ${s.typeText} } from "${spec}";`];
  const text = files.get(target) ?? "";
  files.set(target, [...head.filter((h) => !text.includes(h)), ...(text ? [text.replace(/\n*$/, "")] : []), "", ...lines, ""].join("\n"));
  return null;
}

/** OARC-E092 detail when the project can't run UI checks: `ui.dom` not set to "jsdom" in openarc.config.json, or jsdom,
 *  react or react-dom not installed. There is no unverified fallback. */
export async function domProblem(ports: Ports, dom: string | undefined): Promise<string | null> {
  if (dom !== "jsdom") return "dom:not-configured";
  for (const m of ["jsdom", "react", "react-dom"]) if ((await ports.fs.read(`node_modules/${m}/package.json`)) === null) return `dom:${m}-missing`;
  return null;
}
