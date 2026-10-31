# Writing Specs

## Function regions

```ts
type F = (a: A, b: B) => R;                 // the type is the contract, and it's authoritative
export const fooSpec = arc.defineRegion<F>({
  id: "module.foo",                          // [a-z][a-zA-Z0-9]* segments joined by dots, unique per project
  symbol: "foo",                             // optional; default = last id segment
  intent: "…" | ["…", "…"],                  // guidance for the model; never treated as verified
  effects: [],                               // "clock" | "random" | "log"
  deps: ["./helpers.ts", "node:crypto"],     // the only imports a body may add
  examples: [{ name?: "…", args: [...], expected: …, tolerance?: 1e-6, exact?: false }],
  tolerance: 1e-9,                           // optional: the default numeric tolerance of every example
});
```

**Specs must be static.** Only JSON literals are allowed: no identifiers, spreads, calls or template substitutions. The compiler reads them without running your code (`OARC-E010` otherwise). Use the array form for long intents.

**The signature never comes from the model.** The compiler prints it from `F`, and the model only returns the body.

## How examples compare

`expected` is compared with deep equality, strict about structure and types, with three exceptions for numbers:

| Case | Rule |
|---|---|
| floats | `a` and `b` match when `\|a − b\| ≤ tolerance × max(1, \|a\|, \|b\|)`: relative for large values, absolute near zero. `tolerance` comes from the example, else the spec, else `1e-9` |
| `-0` | equals `0`. JSON can't write `-0`, so `fitLine` returning `[-0, 1, 0]` for a horizontal line passes `expected: [0, 1, 0]` |
| `NaN` | equals `NaN` |

`exact: true` on an example compares numbers bit for bit (`Object.is`: `-0` differs from `0`, no tolerance; `NaN` still equals `NaN`).

JSON has no `NaN`, `Infinity` or `undefined`, so write them as string tokens, in `expected` and in `args`: `"$NaN"`, `"$Infinity"`, `"$-Infinity"`, `"$undefined"`. The harness decodes them wherever they appear (fake `init` values excepted), and the `Example` type accepts them where `F` has a `number` or `undefined`:

```ts
type SegDist = (p: Point, a: Point, b: Point) => number;
examples: [{ args: [[1, 1], [2, 2], [2, 2]], expected: 1.4142135623730951 }, { args: [["$NaN", 0], [0, 0], [1, 0]], expected: "$NaN" }]
```

Failure messages print values faithfully: `got [-0,1,NaN]; expected [0,1,0]`, not `got [0,1,null]`.

## Thin examples

Examples are the only behaviour OpenArc checks, and in the evaluation three regions passed every example while disagreeing with the original code on ordinary inputs (`coverage` 50/80, `outputFileName` 8/40, `resolveChannelId` 1 of 5 URL forms). Two tools help:

- **`OARC-W044`** warns, when a function region is compiled, if it has fewer than 3 examples (detail `examples:<n>`) or if no example has an edge-case argument: `""`, `[]`, `{}`, `0`, a negative number, `null`, or a `$NaN`/`$Infinity`/`$undefined` token (detail `no-edge-case`). It's a cheap syntactic heuristic, so a boundary such as `5` in a `1..5` range goes unnoticed.
- **`openarc check <id> --oracle <module>#<export>`** compares the compiled region with a reference implementation you already have (the code you are porting). It runs both, in the sandbox, on the examples' argument lists plus seeded variations of them (60 inputs, seed 1, so the run is reproducible), and prints every input where they disagree. Two results agree when they are equal under the rules above, or when both throw. Only arguments made of numbers, strings, booleans, and arrays or objects of those are varied; examples with fakes or `null` are skipped. Variations keep shapes: a top-level array changes length only if the examples show different lengths there (so `[x, y]` stays a pair), and strings are sometimes swapped for another example's string at the same position (enum-like values). The module must be inside the project and self-contained (only it is copied into the sandbox); `.js` works.

```
$ npx openarc check text.outputFileName --oracle legacy/text.js#outputFileName
  #14 args ["João","Mirão",2024,"x"]: got "Joo_Miro_2024_x.txt"; oracle "Joao_Mirao_2024_x.txt"
check text.outputFileName against legacy/text.js#outputFileName: 52/60 inputs agree (seed 1)
```

Add the inputs it finds as examples, and recompile.

## What is verified, and what isn't

| Guaranteed (mechanically checked) | Not guaranteed |
|---|---|
| The body type-checks against `F` | Behaviour beyond your examples |
| Only declared imports and effects | Following the `intent` prose |
| Your examples pass, in the sandbox | Identical output on a fresh regeneration |
| Hand edits are never overwritten | |
| A failed compile writes nothing | |

## Block regions (mixed resolution)

Hand-write a function's control flow and leave the steps abstract:

```ts
export const stepSpec = arc.defineBlock({ id: "job.run.load", intent: "rows = await loadRows(db, req.table)" });

// @openarc:begin job.run
export async function run(db: Db, req: Req): Promise<Result> {
  let rows: Row[] = [];
  // @openarc:begin job.run.load
  arc.pending("job.run.load");
  // @openarc:end job.run.load
  if (rows.length === 0) return { ok: false };
  …
}
// @openarc:end job.run
```

Rules for blocks:
- **No escaping control flow:** no `return`/`break`/`continue` out of the block, and no `this`, `arguments` or `super`. Arrow functions are transparent to `this` and `arguments`, so those are caught inside arrows too.
- **Communicate through `let` variables declared above the block.** The parent owns all control flow.
- **They're verified through the enclosing function's examples.** Sibling blocks are jointly re-verified before commit.

## Ownership states

| State | Meaning |
|---|---|
| `pending` | body is the placeholder; will be generated |
| `compiler` | body is exactly what OpenArc committed; may be regenerated when stale |
| `stale` (display only) | a `compiler` region whose spec (or, when known, fingerprint) no longer matches the manifest: the body was verified against an older spec. `graph`, `inspect` and watch show it; if its recompile fails, `compile` reports `OARC-W043` and exits 1. Ownership is still `compiler` |
| `developer` | you edited it, froze it, or wrote it yourself; never written by OpenArc |
| `conflicted` | spec changed under a developer-owned body, or markers were damaged; resolve explicitly |
