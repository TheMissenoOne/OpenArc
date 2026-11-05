import * as arc from "open-arc";
import type { Diagnostic } from "./types.ts";

// ── block.checkRestrictions ───────────────────────────────────── spec §3.4
type CheckRestrictions = (body: string, enclosingIsAsync: boolean, usedAfter: string[]) => Diagnostic[];

export const checkRestrictionsSpec = arc.defineRegion<CheckRestrictions>({
  id: "block.checkRestrictions",
  intent: [
    "Parse body as statements. Emit OARC-E035 with a detail token, in source order, for:",
    "return | yield | await (only when !enclosingIsAsync) | label | break/continue whose target loop or switch is outside body,",
    "this | arguments | super | new.target;",
    "and binding:<name> for each top-level declaration of body whose name is in usedAfter.",
    "Non-arrow functions, methods, accessors and classes are opaque: nothing inside them is reported.",
    "ARROW functions are transparent for this/arguments/super/new.target, because arrows capture them lexically.",
    "Method: ts.createSourceFile('b.ts', body, ts.ScriptTarget.Latest, true), then recurse with node.forEachChild, carrying loop depth, switch depth and whether you are inside an arrow.",
    "Guards that exist: ts.isReturnStatement, isYieldExpression, isAwaitExpression, isLabeledStatement, isBreakStatement, isContinueStatement, isIterationStatement(n, false), isSwitchStatement, isFunctionDeclaration, isFunctionExpression, isMethodDeclaration, isGetAccessor, isSetAccessor, isClassLike, isArrowFunction, isMetaProperty, isVariableStatement. this and super: n.kind === ts.SyntaxKind.ThisKeyword or SuperKeyword. arguments: ts.isIdentifier(n) && n.text === 'arguments', unless it is the property name of a property access (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n). Nothing else from ts is needed.",
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
    {
      name: "function expressions, methods, accessors and classes are opaque",
      args: ["const o = { m() { return this; }, get v() { return this; }, set v(x) { this.x = x; } }; const f = function () { return arguments; }; class C { y = this; }", false, []],
      expected: [],
    },
    { name: "continue: labeled, or outside any loop", args: ["while (a) { continue outer; }\ncontinue;", false, []], expected: [{ code: "OARC-E035", detail: "continue" }, { code: "OARC-E035", detail: "continue" }] },
    { name: "arguments object (not a property named arguments)", args: ["x = arguments.length;", false, []], expected: [{ code: "OARC-E035", detail: "arguments" }] },
    { name: "a property named arguments", args: ["x = obj.arguments;", false, []], expected: [] },
    { name: "new.target", args: ["if (!new.target) throw e;", false, []], expected: [{ code: "OARC-E035", detail: "new.target" }] },
  ],
});

// @openarc:begin block.checkRestrictions
export const checkRestrictions: CheckRestrictions = (body, enclosingIsAsync, usedAfter) =>
  arc.todo("block.checkRestrictions");
// @openarc:end block.checkRestrictions
