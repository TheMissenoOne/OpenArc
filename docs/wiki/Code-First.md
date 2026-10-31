# Code First

Since 0.9.0 the main way to write an OpenArc program is ordinary TypeScript. You write interfaces, classes, the members you know how to write, and tests. Where the compiler should write a body, you write `return arc.todo();`. Everything else in this page follows from that one rule.

```ts
import * as arc from "open-arc";

export interface Backend { id: string; healthy: boolean }

/** Routes requests to backends. */
export interface Balancer {
  /** The backend id for one request, or null when no backend is healthy. */
  pick(key: string): string | null;
  /** Take a backend out of rotation. Throws "unknown backend <id>" for an id it doesn't have. */
  markDown(id: string): void;
}

export class RoundRobin implements Balancer {
  readonly backends: Backend[];
  /** Position in the healthy list of the next pick. */
  next = 0;
  constructor(backends: Backend[]) {
    this.backends = backends.map((b) => ({ ...b }));
  }
  healthy(): Backend[] {
    return this.backends.filter((b) => b.healthy);
  }
  /** The next healthy backend in list order, wrapping around. Keys are ignored. */
  pick(key: string): string | null {
    return arc.todo();
  }
  markDown(id: string): void {
    return arc.todo();
  }
}
```

`pick` and `markDown` are two regions. `healthy()`, the fields and the constructor are yours and are the model's context. `markDown` has no JSDoc of its own, so it inherits `Balancer.markDown`'s.

## What is a region

A declaration is a pending region when its whole body is `return arc.todo();`, `arc.todo();`, or (for an arrow) the expression `arc.todo()`:

| Declaration | Region? |
|---|---|
| top-level `function f(…): R { … }` | yes |
| top-level `const f = (…): R => …` (or `const f: F = (…) => …`) | yes |
| class methods (static or instance), getters, arrow-valued class properties | yes |
| constructors, setters, nested functions, object-literal methods | no: the developer writes them |
| files named `*.test.ts` | no: they hold tests |

**The return type must be written.** `pick(key: string) { return arc.todo(); }` would infer `never`, which every caller accepts: that's `OARC-E022`. Parameter types are required by `strict` anyway. **Generics are allowed**: the body must type-check under the type parameters.

**Nothing is executed to find regions.** The compiler reads declarations, JSDoc, tests and `arc.configure` with the TypeScript AST and the checker.

## Ids

`id = <module>[.<class>].<member>`:

- `<module>` is the file's path under `src/`, without the extension or a trailing `index`, each segment camel-cased with a lower-case first letter: `src/lb/balancer.ts` gives `lb.balancer`. `/** @arc module lb */` at the top of a file overrides it.
- `<class>` is the class name with a lower-case first letter; it's left out when it equals the file name (`src/lb/RoundRobin.ts` gives `lb.roundRobin.pick`).
- A top-level function named like its file isn't repeated (`src/ui/field.ts`'s `field` is `ui.field`).
- `@arc id <id>` in the JSDoc, or `arc.todo("<id>")`, sets the whole id. Two declarations with one id are `OARC-E011`.

The derived id is used only while a region is pending. At its first commit the compiler writes markers **inside** the body, and from then on the markers are its identity:

```ts
  pick(key: string): string | null {
    // @openarc:begin lb.balancer.roundRobin.pick
    const hs = this.healthy();
    if (hs.length === 0) return null;
    const b = hs[this.next % hs.length]!;
    this.next = (this.next + 1) % hs.length;
    return b.id;
    // @openarc:end lb.balancer.roundRobin.pick
  }
```

So renaming the method, the class or the file after a commit keeps the id, and everything that works for regions works here: the owned-text hash, `OARC-W060` when you edit the body by hand, `OARC-E062` when you delete the markers, `freeze`/`release`/`resolve`. An `@arc id` that disagrees with the markers is `OARC-E064`. A pending body is never rewritten on disk: if it isn't compiled in a run (it failed, or wasn't requested), the file keeps `return arc.todo();` exactly as you wrote it.

## Intent: JSDoc

The intent is the declaration's JSDoc: the description, then `@param`, `@returns` and `@throws`. A class member without JSDoc inherits the JSDoc of the interface member (or base-class member) it implements. JSDoc is guidance, as `intent` always was: it's never verified. A region with no JSDoc anywhere gets `OARC-W023` at PLAN: its signature and tests are then the model's only guidance.

## Tests

Tests are TypeScript, type-checked against your real code. Put them anywhere in `src/` or `tests/`; `*.test.ts` next to the code is the convention, and a test in the same file as its region works too.

```ts
import * as arc from "open-arc";
import { RoundRobin, type Backend } from "../src/lb/balancer.ts";

const three: Backend[] = [{ id: "a", healthy: true }, { id: "b", healthy: true }, { id: "c", healthy: true }];

arc.test(RoundRobin, "markDown skips the backend and keeps the position", (RR, expect) => {
  const rr = new RR(three);                 // construct, then call: state the natural way
  expect(rr.pick("x")).toBe("a");
  rr.markDown("b");
  expect(rr.pick("x")).toBe("c");
  expect(() => rr.markDown("z")).toThrow("unknown backend z");
});

arc.test.hidden(RoundRobin, "fair over 300 picks", (RR, expect) => {
  const rr = new RR(three);
  const counts: Record<string, number> = {};
  for (let i = 0; i < 300; i++) {
    const id = rr.pick(String(i))!;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  expect(counts).toEqual({ a: 100, b: 100, c: 100 });
});

arc.law(RoundRobin, "never picks an unhealthy backend", (RR, expect, gen) => {
  let n = 0;
  const backends = gen.array((g) => ({ id: `b${n++}`, healthy: g.bool() }), { max: 6 });
  const id = new RR(backends).pick("k");
  expect(id === null ? !backends.some((b) => b.healthy) : backends.some((b) => b.id === id && b.healthy)).toBe(true);
});
```

| Call | What it is |
|---|---|
| `arc.test(target, name, (subject, expect, fakes) => …)` | a test. `target` is the function or the class; the body gets it back as `subject` |
| `arc.test.hidden(…)` | the same, held out from the model: it runs in every sandbox run and counts, but the model never sees it, and a failure reaches the model as `hidden test failed: "<name>"` only |
| `arc.law(target, name, (subject, expect, gen) => …, { runs?, seed? })` | a property: the body runs `runs` times (default 50) with a generator seeded from `seed` (default 1). A failing law reports its run, seed and every draw |

**`expect` is small and deterministic.** `toBe` (`Object.is`, except `-0` equals `0`), `toEqual(x, { tolerance?, exact? })` (the example equality: numbers within 1e-9 relative, `NaN` equals `NaN`), `toMatch`, `toHaveLength`, `toContain`, `toThrow(message?)` on a function, `await toReject(message?)` on a promise. A failed `expect` is recorded and the test goes on, so one run reports every failing assertion with its line and source. No timers, snapshots on disk, module mocks, `only` or `skip`.

**`gen`** draws `int(lo, hi)`, `bool()`, `pick(xs)`, `string({ max?, alphabet? })` and `array(item, { min?, max? })` from the mulberry32 generator `check --oracle` uses.

**Fakes by type.** `fakes.of<Transport>()` is resolved when the compiler reads the test: it finds the one `export default defineFake<Transport>(…)` in `tests/fakes/` (none or two is `OARC-E010` detail `fake:<type>`). `fakes.named("<file>", init)` names one directly, and `fakes.snapshot(instance)` returns its `snapshot()`. See [[Fakes]].

**Which tests run for a region:** those whose target is the region's function, its class, or a class its class extends. `arc.test(C.prototype.m, …)` narrows a test to one member.

**Tests run only in the sandbox.** The compiler builds a static plan from the test statements (top-level `arc.test(...)` calls with a literal name and an inline body; anything else is `OARC-E010` detail `test:…`). In the sandbox, the harness imports the test files and refuses a registry that differs from the plan (`OARC-E090` detail `test-registry:…`), so a test registered in a loop never runs unseen. Test files are never written by the compiler.

**Coverage.** Every code-first region gets a probe in the sandbox's copy. A region counts as verified only if a passing test or example reaches it; otherwise it's `OARC-W045` (detail `unreached:<id>`), not cached as verified and not committed.

## Classes: verified together

The class shell (heritage, fields with their initializers, the constructor, every member's signature and JSDoc) is the model's context and is yours: the compiler only writes between the markers inside a pending body, and the splice guard checks that everything else is byte-identical.

Tests construct the class and call several members, so the members of one class are compiled in source order and verified together:

- While `pick` is generated, a test that also calls the still-pending `markDown` is **inconclusive**, not failed (`tests:4/6 (2 inconclusive: pending regions)`).
- Before the commit, every generated member of the class is re-run with all of them in place. A real failure stops the commit (`OARC-E090` detail `joint:…`); a member no passing test reaches holds the class back (`OARC-W045` for it, `OARC-W042` for the others).

An abstract base class with concrete helpers is shown as context to every subclass region.

## What the model sees

For `pick` above, the context package has a **Contract** section: the class shell, with JSDoc in place and `<<<BODY>>>` where the body goes; the other members by signature, marked `implemented` or `pending: compiled jointly with this member`. Then the types the shell reaches (the interfaces, verbatim), the file's imports, and the **tests**: the source of the shown tests that target the region, with the test-file constants they read, and `// plus N hidden test(s), not shown`. When the package is over budget, a summary of the literal assertions (`rr.pick("x") → "a"`) replaces the test source before anything else is dropped. See [[Context Packages]].

## The customization layer

Three optional ways to add what a signature can't say. Each field may be set in one place only (two places is `OARC-E013`, detail `<field>:<layers>`); intents, examples and tests add up.

```ts
/**
 * Mark one backend unhealthy.
 * @arc calls none
 * @arc effects clock
 * @arc backend big
 */
markDown(id: string): void { return arc.todo(); }

arc.configure(hash32, { examples: [{ args: [""], expected: 2166136261 }], deps: ["./ring.ts"] });

export const markDownSpec = arc.defineRegion<(id: string) => void>({ id: "lb.roundRobin.markDown", intent: "Logs nothing." });
```

| Layer | Fields |
|---|---|
| JSDoc `@arc` tags | `calls`, `effects`, `deps` (a list, `none` for empty), `backend`, `outputFormat`; also `id` and (at the top of a file) `module` |
| `arc.configure(target, { … })` | `calls`, `effects`, `deps`, `tolerance`, `backend`, `outputFormat`, `examples`, `intent`; static JSON only, a no-op at runtime |
| `defineRegion` with the region's id | attaches instead of creating a region; its `F` must match the declaration (`OARC-E020`); its `intent` is appended to the JSDoc |

`openarc.config.json` `regions[id]` still wins for `backend`, `outputFormat` and `contextLevel` (it's machine configuration, not spec). JSON examples work for top-level functions only; methods are verified by tests (`OARC-E010` detail `examples:method`). `@arc calls this.net.send` works for a port held in a field whose type is a project interface.

**What the spec hash covers:** the declaration's head and JSDoc, the merged configuration (not `backend` or `outputFormat`) and the source of every test that targets the region, hidden ones included. Changing any of them makes a compiler-owned region stale; a sibling's body never does.

## Adopting existing code

`openarc extract src/x.ts` adopts the file's exported functions in code-first form: markers inside each body, `@arc id` added to the JSDoc, bodies kept byte for byte, developer-owned. `--style region` writes the earlier `defineRegion` form. See [[Adopting Existing Code]].

## Migrating a `defineRegion` region

`openarc migrate <id>` converts one classic function region in one transaction:

1. `export const s: F = (a, b) => { … }` becomes `export function s(a: A, b: B): R { … }`, with the markers inside the body.
2. The intent becomes the JSDoc, with `@arc id <id>`.
3. `examples`, `calls`, `effects`, `deps` and `tolerance` move to `arc.configure(s, { … })` unchanged; the `defineRegion` statement goes (its type alias stays).
4. The id, ownership and provenance are kept, and the new body's hash and spec hash are recorded, so the move is neither a hand edit nor a spec change.

It refuses regions with block children, sketches, UI structures, concept variants, conflicted regions and a spec export used from another file. It never runs implicitly.

## Not yet

From the design's later phases: laws over every implementation of an interface (`arc.law(arc.implementations<I>(), …)`) with `@arc waive`, `arc.implement<I>()` scaffolding, in-place sketches (`arc.hole` inside an ordinary body), and atomic-design TSX regions with `arc.render`. Until then, sketches, concepts and UI specs work through `defineRegion` (see [[Writing Specs]]).

To build reusable building blocks of your own (concepts with laws, variants, code-first classes and tests, exported from your project or your own package), see [[Your own palette|Palette]].

A full project: [`examples/code-first-demo`](https://github.com/TheMissenoOne/OpenArc/tree/main/examples/code-first-demo).
