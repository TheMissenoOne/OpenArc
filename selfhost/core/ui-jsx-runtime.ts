// JSX runtime for `/** @jsxImportSource open-arc/ui */` spec files: lets tsc check a `ui:` structure against the
// vocabulary in ./ui.ts. There are no intrinsic (lowercase) elements, so `<div>` in a spec is a type error.
import type { UiNode } from "./index.ts";

type Component = (props: never) => UiNode;
export function jsx(tag: Component, props: Record<string, unknown>): UiNode {
  return (tag as (p: Record<string, unknown>) => UiNode)(props);
}
export const jsxs = jsx;
export function Fragment(props: { children?: unknown }): UiNode {
  return { tag: "Fragment", props: {}, children: ([] as unknown[]).concat(props.children ?? []) as UiNode[] };
}
export declare namespace JSX {
  type Element = UiNode;
  interface IntrinsicElements {}
  interface ElementChildrenAttribute {
    children: {};
  }
}
