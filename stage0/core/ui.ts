// The UI structure vocabulary (SPEC §2.6): the words a `ui:` spec may use, with typed props. A `*.spec.tsx` file with
// `/** @jsxImportSource open-arc/ui */` type-checks its `ui` against these. The compiler reads `ui` as syntax and never
// runs it; these functions only build the tree the type checker sees. Each word's meaning, and the DOM check that
// verifies it, live in the compiler (src/ui.ts) and the harness (core/ui-harness.ts).
import type { UiNode } from "./index.ts";

type Kids = UiNode | string | (UiNode | string)[];
const node = (tag: string, props: { children?: Kids } & Record<string, unknown>): UiNode => {
  const { children, ...rest } = props;
  return { tag, props: rest, children: children === undefined ? [] : Array.isArray(children) ? children : [children] };
};

/** A <form> with a heading `title`. On submit it calls onSubmit with { <field name>: value } for every Field; a result
 *  with ok: false shows its `error` in ErrorText; ok: true calls onSuccess with the result. */
export function Form(p: { title: string; onSubmit: (values: never) => unknown; onSuccess?: (result: never) => unknown; children?: Kids }): UiNode {
  return node("Form", p);
}
/** A labelled <input>: the label is its accessible name. `secret` means type="password". */
export function Field(p: { name: string; label: string; type?: "text" | "email" | "number" | "tel" | "url"; secret?: boolean; required?: boolean; autoComplete?: string }): UiNode {
  return node("Field", p);
}
/** role="alert": the last failure message, empty when there is none. */
export function ErrorText(p: { children?: never }): UiNode {
  return node("ErrorText", p);
}
/** A submit button named by its text; disabled and showing busyText while onSubmit is pending. */
export function Submit(p: { children: string; busyText?: string }): UiNode {
  return node("Submit", p);
}
