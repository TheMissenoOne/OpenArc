import * as arc from "@openarc/core";
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
export const checkRestrictions: CheckRestrictions = (body, enclosingIsAsync, usedAfter) =>
  arc.todo("block.checkRestrictions");
// @openarc:end block.checkRestrictions
