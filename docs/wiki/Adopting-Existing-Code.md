# Adopting Existing Code

You don't have to start from specs. `openarc extract` turns functions you already have into OpenArc regions without changing a byte of their bodies.

```bash
npx openarc extract src/text-utils.ts                       # every exported function in the file
npx openarc extract src/text-utils.ts --function slug       # one function (exported or not)
npx openarc extract src/text-utils.ts --function slug --id text.makeSlug
```

## What it writes

Given

```ts
/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}
```

`extract` produces

```ts
import * as arc from "@openarc/core";
type AddFn = (a: number, b: number) => number;

export const addSpec = arc.defineRegion<AddFn>({
  id: "textUtils.add",
  intent: ["[inferred] Adds two numbers."],
  examples: [],
});

/** Adds two numbers. */
// @openarc:begin textUtils.add
export function add(a: number, b: number): number {
  return a + b;
}
// @openarc:end textUtils.add
```

- **`type AddFn`** is printed by the TypeScript checker from the function's real signature.
- **The id** defaults to `<file-stem>.<functionName>`, normalised to the id grammar (`text-utils` becomes `textUtils`). Use `--id` (with `--function`) to choose one.
- **The intent** is the first JSDoc line, or `TODO describe`. The `[inferred]` prefix marks it for your review.
- **The JSDoc** stays above the markers, so it survives a later regeneration.
- **The manifest** records the region as `developer`, with `provenance.source: "extracted"`. OpenArc never writes to developer regions, so nothing is regenerated.

The file and the manifest are written in one transaction. Running `extract` again is a no-op: functions already inside a region are skipped.

## Handing a region to the compiler

1. Review the intent and drop the `[inferred]` prefix.
2. Add `examples`: they are the region's tests, and the only thing that lets the compiler regenerate it safely.
3. Run `openarc release <id>`. The current body is backed up to `.openarc/backup/`, and the next `openarc compile` generates and verifies a new one.

If you edit the spec but keep the hand-written body, the region is a developer region whose spec changed, so the next compile reports `OARC-E061`. Run `openarc resolve <id> --keep` to accept it.

## What it refuses

`extract` exits 1 with a message, and writes nothing for that function, when it finds:

| Case | Why |
|---|---|
| overloaded functions | a region holds one declaration with one call signature |
| generic functions | `defineRegion<F>` needs a non-generic `F` |
| `export default function () {}` and other anonymous default exports | a region needs a name; give it one first |
| class methods | regions are top-level functions (§3.2); move the logic out of the class |
| a declaration sharing a line with other code | markers need whole lines |
| an invalid or already-used id | ids are unique (§2.3) |
| a result that type-checks worse than the original | e.g. a `package.json` without `"type": "module"`, where the added `import` is a TS1295 error |

Files must be under `src/`, where OpenArc looks for regions.
