// UI harness (SPEC §9.6): renders a UI region's React component in jsdom, inside the sandbox, and runs
// 1. the derived structure and accessibility checks (from the `ui` tree, tier Derived),
// 2. the derived wiring example (fill every Field, submit, the Form's onSubmit prop gets { name: value }),
// 3. the spec's interaction-script examples (fill by label, click by role and name, then `dom` and `fakesAfter`).
// Hand-written bootstrap code. jsdom, react and react-dom come from the PROJECT's node_modules (config `ui.dom`).
// `.tsx` modules are transpiled in-thread with the project's TypeScript (module.registerHooks: no worker needed).
import { createRequire, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import type { FakeFactory, FakeInstance, FakeRef, Json, UiNode, UiStep, UiTarget } from "./index.ts";
import { decodeTokens, toJson, valuesEqual, type Outcome } from "./harness.ts";

type Tree = UiNode;
export interface UiPlan {
  module: string;
  symbol: string;
  examples?: Json[];
  ui: { param: string | null; root: Tree };
}
type Example = { name?: string; args?: Json[]; script?: UiStep[]; dom?: { text?: string[]; notText?: string[]; enabled?: UiTarget[]; disabled?: UiTarget[] }; fakesAfter?: Record<string, Json> };
// Structural DOM types: core is compiled without the DOM lib.
type El = {
  textContent: string | null; innerHTML: string; getAttribute(n: string): string | null; querySelector(s: string): El | null; click(): void; dispatchEvent(e: unknown): boolean;
  name?: string; type?: string; required?: boolean; disabled?: boolean; value?: string; htmlFor?: string;
};
type Doc = { body: El; getElementById(id: string): El | null; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El> };

const isFakeRef = (v: unknown): v is FakeRef => typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as FakeRef).$fake === "string";
const nodesOf = (t: Tree, tag: string): Tree[] => [...(t.tag === tag ? [t] : []), ...t.children.flatMap((c) => (typeof c === "string" ? [] : nodesOf(c, tag)))];
const textOf = (t: Tree) => t.children.filter((c): c is string => typeof c === "string").join(" ").trim();
const refProp = (v: unknown): string | null => (typeof v === "object" && v !== null && "$ref" in v ? String((v as { $ref: unknown }).$ref).split(".").slice(1).join(".") || null : null);

/** The built-in `action` fake: a function that records its calls and returns init.returns[i] for the i-th call. */
const action = (init: Json | undefined): FakeInstance<(...a: unknown[]) => Promise<unknown>> => {
  const returns = ((init as { returns?: Json[] } | undefined)?.returns ?? []) as unknown[];
  const calls: unknown[][] = [];
  return { instance: async (...a) => (calls.push(a), structuredClone(returns[calls.length - 1])), snapshot: () => ({ calls: toJson(calls) }) };
};

export async function runUi(root: string, plan: UiPlan): Promise<Outcome[]> {
  const req = createRequire(join(root, "package.json"));
  const ts = req("typescript") as typeof import("typescript");
  registerHooks({
    load(url, context, next) {
      if (!url.endsWith(".tsx")) return next(url, context);
      const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        fileName: fileURLToPath(url),
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
      }).outputText;
      return { format: "module", source, shortCircuit: true };
    },
  });
  const load = async (m: string) => import(pathToFileURL(req.resolve(m)).href);
  const jsdom = await load("jsdom");
  const JSDOM = (jsdom.JSDOM ?? jsdom.default.JSDOM) as new (html: string, o?: object) => { window: Record<string, unknown> & { document: Doc } };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  for (const k of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLFormElement", "Event", "InputEvent", "KeyboardEvent", "MouseEvent", "FocusEvent", "FormData", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
    if (k in dom.window || k === "window") Object.defineProperty(globalThis, k, { value: k === "window" ? dom.window : dom.window[k], configurable: true, writable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const React = (await load("react")) as { createElement(c: unknown, p: unknown): unknown; act(f: () => Promise<void> | void): Promise<void>; default?: unknown };
  const act = (React.act ?? (React.default as typeof React).act).bind(React);
  const createElement = (React.createElement ?? (React.default as typeof React).createElement).bind(React);
  const { createRoot } = (await load("react-dom/client")) as { createRoot(el: unknown): { render(e: unknown): void; unmount(): void } };
  const Component = (await import(pathToFileURL(join(root, plan.module)).href))[plan.symbol];
  const doc = dom.window.document;
  const win = dom.window as unknown as { HTMLInputElement: { prototype: object }; Event: new (t: string, o?: object) => unknown };

  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  let mounted: { unmount(): void } | null = null;
  const mount = async (props: unknown) => {
    if (mounted) await act(() => mounted!.unmount());
    doc.body.innerHTML = '<div id="root"></div>';
    const r = createRoot(doc.getElementById("root"));
    await act(() => r.render(createElement(Component, props)));
    mounted = r;
  };
  // Elements by accessible name: a label's text (label[for], or a wrapping label), aria-label, or a button's text.
  const all = (sel: string) => Array.from(doc.querySelectorAll(sel));
  const byLabel = (text: string): El | null => {
    const label = all("label").find((l) => l.textContent?.trim() === text);
    const viaFor = label?.htmlFor ? doc.getElementById(label.htmlFor) : null;
    return viaFor ?? label?.querySelector("input,textarea,select") ?? all("input,textarea,select").find((x) => x.getAttribute("aria-label") === text) ?? null;
  };
  const byRole = (t: UiTarget): El | null =>
    all(t.role === "button" ? "button,[role=button],input[type=submit]" : `[role=${t.role}]`).find((x) => (x.getAttribute("aria-label") ?? x.textContent ?? x.value ?? "").trim() === t.name) ?? null;
  const fill = async (el: El, value: string) => {
    await act(() => {
      (Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set as (v: string) => void).call(el, value);
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
  };
  const click = async (el: El) => {
    await act(async () => el.click());
    await settle();
  };
  // Props for a render: fakes resolved anywhere inside args[0] (action#<name> is built in; others come from tests/fakes).
  const props = async (args: Json[] | undefined, fakes: Map<string, FakeInstance<unknown>>) => {
    const resolve = async (v: unknown): Promise<unknown> => {
      if (isFakeRef(v)) {
        let inst = fakes.get(v.$fake);
        if (!inst) {
          const file = v.$fake.split("#")[0]!;
          inst = file === "action" ? action(v.init) : ((await import(pathToFileURL(join(root, "tests", "fakes", `${file}.ts`)).href)).default as FakeFactory<unknown>)(v.init);
          fakes.set(v.$fake, inst);
        }
        return inst.instance;
      }
      if (Array.isArray(v)) return Promise.all(v.map(resolve));
      if (typeof v === "object" && v !== null) return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await resolve(x)])));
      return v;
    };
    return resolve(decodeTokens(args?.[0] ?? {}));
  };

  const out: Outcome[] = [];
  const report = (name: string, problems: string[]) => out.push(problems.length ? { name, ok: false, actual: { problems } } : { name, ok: true });
  const tree = plan.ui.root;
  const fields = nodesOf(tree, "Field");
  const examples = (plan.examples ?? []) as Example[];
  const submitText = nodesOf(tree, "Submit").map(textOf)[0];

  // 1. derived structure and accessibility checks
  {
    const problems: string[] = [];
    await mount(await props(examples[0]?.args, new Map()));
    for (const f of nodesOf(tree, "Form")) {
      if (!doc.querySelector("form")) problems.push("Form: no <form>");
      const title = String(f.props.title ?? "");
      if (title && !all("h1,h2,h3,legend").some((x) => x.textContent?.trim() === title)) problems.push(`Form: no heading "${title}"`);
    }
    for (const f of fields) {
      const label = String(f.props.label), want = f.props.secret ? "password" : String(f.props.type ?? "text");
      const el = byLabel(label);
      if (!el) {
        problems.push(`Field ${String(f.props.name)}: no input labelled "${label}" (a11y: accessible name)`);
        continue;
      }
      if (el.name !== f.props.name) problems.push(`Field ${String(f.props.name)}: name="${el.name}"`);
      if (el.type !== want) problems.push(`Field ${String(f.props.name)}: type="${el.type}", want "${want}"`);
      if (!!f.props.required !== el.required) problems.push(`Field ${String(f.props.name)}: required=${el.required}`);
      if (typeof f.props.autoComplete === "string" && el.getAttribute("autocomplete") !== f.props.autoComplete) problems.push(`Field ${String(f.props.name)}: autocomplete="${el.getAttribute("autocomplete")}", want "${f.props.autoComplete}"`);
    }
    if (nodesOf(tree, "ErrorText").length && !doc.querySelector("[role=alert]")) problems.push('ErrorText: no element with role="alert"');
    if (submitText !== undefined) {
      const b = byRole({ role: "button", name: submitText });
      if (!b || b.type !== "submit") problems.push(`Submit: no submit button named "${submitText}"`);
    }
    report("ui: structure and accessibility", problems);
  }
  // 2. the derived wiring example: every Field filled, Submit clicked, the onSubmit prop called once with { name: value }
  const target = refProp(tree.props.onSubmit);
  if (target && submitText !== undefined) {
    const problems: string[] = [];
    const fakes = new Map<string, FakeInstance<unknown>>();
    const p = (await props(examples[0]?.args, fakes)) as Record<string, unknown>;
    const spy = action((examples[0]?.args?.[0] as Record<string, { init?: Json }> | undefined)?.[target]?.init);
    await mount({ ...p, [target]: spy.instance });
    const values = Object.fromEntries(fields.map((f) => [String(f.props.name), f.props.type === "email" ? "a@b.co" : `v-${String(f.props.name)}`]));
    for (const f of fields) {
      const el = doc.querySelector(`[name="${String(f.props.name)}"]`);
      if (el) await fill(el, values[String(f.props.name)]!);
      else problems.push(`no input named "${String(f.props.name)}"`);
    }
    const b = byRole({ role: "button", name: submitText });
    if (b) await click(b);
    const got = spy.snapshot() as { calls: Json[] };
    if (!valuesEqual(got.calls, [[values]])) problems.push(`props.${target} called with ${JSON.stringify(got.calls)}, want ${JSON.stringify([[values]])}`);
    report("ui: wiring", problems);
  }
  // 3. the spec's interaction-script examples
  for (const [i, ex] of examples.entries()) {
    const name = ex.name ?? `#${i + 1}`;
    const problems: string[] = [];
    try {
      const fakes = new Map<string, FakeInstance<unknown>>();
      await mount(await props(ex.args, fakes));
      for (const step of ex.script ?? []) {
        if ("fill" in step) {
          const el = byLabel(step.fill.label);
          if (el) await fill(el, step.fill.value);
          else problems.push(`no field labelled "${step.fill.label}"`);
        } else {
          const el = byRole(step.click);
          if (el) await click(el);
          else problems.push(`no ${step.click.role} named "${step.click.name}"`);
        }
      }
      const text = doc.body.textContent ?? "";
      for (const t of ex.dom?.text ?? []) if (!text.includes(t)) problems.push(`text "${t}" is not shown`);
      for (const t of ex.dom?.notText ?? []) if (text.includes(t)) problems.push(`text "${t}" is shown`);
      for (const t of ex.dom?.enabled ?? []) if (byRole(t)?.disabled !== false) problems.push(`${t.role} "${t.name}" is not enabled`);
      for (const t of ex.dom?.disabled ?? []) if (byRole(t)?.disabled !== true) problems.push(`${t.role} "${t.name}" is not disabled`);
      for (const [fake, want] of Object.entries(ex.fakesAfter ?? {})) {
        const got = fakes.get(fake)?.snapshot() ?? null;
        if (!valuesEqual(JSON.parse(JSON.stringify(got)), decodeTokens(want))) problems.push(`${fake}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    } catch (e) {
      problems.push(`throws: ${e instanceof Error ? e.message : String(e)}`);
    }
    report(name, problems);
  }
  if (mounted) await act(() => mounted!.unmount());
  return out;
}
