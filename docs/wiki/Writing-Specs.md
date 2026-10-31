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
  examples: [{ name?: "…", args: [...], expected: … }],
});
```

**Specs must be static.** Only JSON literals are allowed: no identifiers, spreads, calls or template substitutions. The compiler reads them without running your code (`OARC-E010` otherwise). Use the array form for long intents.

**The signature never comes from the model.** The compiler prints it from `F`, and the model only returns the body.

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
| `developer` | you edited it, froze it, or wrote it yourself; never written by OpenArc |
| `conflicted` | spec changed under a developer-owned body, or markers were damaged; resolve explicitly |
