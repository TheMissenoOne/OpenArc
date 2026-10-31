import * as arc from "open-arc";
import type { Diagnostic } from "./types.ts";
import ts from "typescript";

// ── block.checkRestrictions ───────────────────────────────────── spec §3.4
type CheckRestrictions = (body: string, enclosingIsAsync: boolean, usedAfter: string[]) => Diagnostic[];

export const checkRestrictionsSpec = arc.defineRegion<CheckRestrictions>({
  id: "block.checkRestrictions",
  intent: [
    "Parse body as statements. Emit OARC-E035 with a detail token, in source order, for:",
    "return | yield | await (only when !enclosingIsAsync) | label | break/continue whose target loop or switch is outside body,",
    "this | arguments | super | new.target;",
    "and binding:<name> for each top-level declaration of body whose name is in usedAfter.",
    "Non-arrow functions, methods and classes are opaque: nothing inside them is reported.",
    "ARROW functions are transparent for this/arguments/super/new.target, because arrows capture them lexically.",
  ],
  deps: ["typescript"],
  examples: [
    { name: "plain assignment", args: ["x = x + 1;", false, []], expected: [] },
    { name: "return", args: ["return 1;", false, []], expected: [{ code: "OARC-E035", detail: "return" }] },
    { name: "await in async parent", args: ["await f();", true, []], expected: [] },
    { name: "await in sync parent", args: ["await f();", false, []], expected: [{ code: "OARC-E035", detail: "await" }] },
    { name: "break inside own loop", args: ["for (;;) { break; }", false, []], expected: [] },
    { name: "break to outside", args: ["if (a) break;", false, []], expected: [{ code: "OARC-E035", detail: "break" }] },
    { name: "return inside nested function", args: ["function g() { return this; }", false, []], expected: [] },
    { name: "this through arrow", args: ["const g = () => this;", false, []], expected: [{ code: "OARC-E035", detail: "this" }] },
    { name: "binding used later", args: ["const y = 2;", false, ["y"]], expected: [{ code: "OARC-E035", detail: "binding:y" }] },
    { name: "binding not used later", args: ["const y = 2; x = y;", false, ["z"]], expected: [] },
  ],
});

// @openarc:begin block.checkRestrictions
export const checkRestrictions: CheckRestrictions = (body, enclosingIsAsync, usedAfter) => {
  const sf = ts.createSourceFile("b.ts", body, ts.ScriptTarget.Latest, true);
  const out: Diagnostic[] = [];
  const report = (detail: string) => out.push({ code: "OARC-E035", detail });
  const opaque = (n: ts.Node) =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n) || ts.isClassLike(n) ||
    ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n);
  const visit = (n: ts.Node, loops: number, switches: number, inArrow: boolean): void => {
    if (opaque(n)) return;
    if (ts.isArrowFunction(n)) return n.forEachChild((c) => visit(c, 0, 0, true));
    if (!inArrow) {
      if (ts.isReturnStatement(n)) report("return");
      if (ts.isYieldExpression(n)) report("yield");
      if (ts.isAwaitExpression(n) && !enclosingIsAsync) report("await");
      if (ts.isLabeledStatement(n)) report("label");
      if (ts.isBreakStatement(n) && (n.label || (loops === 0 && switches === 0))) report("break");
      if (ts.isContinueStatement(n) && (n.label || loops === 0)) report("continue");
    }
    if (n.kind === ts.SyntaxKind.ThisKeyword) report("this");
    if (n.kind === ts.SyntaxKind.SuperKeyword) report("super");
    if (ts.isIdentifier(n) && n.text === "arguments" && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) report("arguments");
    if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.NewKeyword) report("new.target");
    const loop = ts.isIterationStatement(n, false) ? 1 : 0;
    const sw = ts.isSwitchStatement(n) ? 1 : 0;
    n.forEachChild((c) => visit(c, loops + loop, switches + sw, inArrow));
  };
  sf.statements.forEach((s) => visit(s, 0, 0, false));
  for (const s of sf.statements) {
    const names = ts.isVariableStatement(s)
      ? s.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []))
      : (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name ? [s.name.text] : [];
    for (const name of names) if (usedAfter.includes(name)) report(`binding:${name}`);
  }
  return out;
};
// @openarc:end block.checkRestrictions
