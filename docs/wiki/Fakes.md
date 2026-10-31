# Fakes: testing functions with effects

Examples are JSON, and ports (filesystem, HTTP, processes) are objects with methods. To bridge the two, an argument can be a **fake reference**:

```ts
examples: [{
  args: [{ $fake: "fs.memory", init: { files: { "a.txt": "old" } } }, "a.txt"],
  expected: "old",                                        // the return value
  fakesAfter: { "fs.memory": { files: { "a.txt": "new" } } }, // the state after the call
}]
```

`tests/fakes/fs.memory.ts`:

```ts
import { defineFake } from "open-arc";
import type { FsPort } from "../../src/types.ts";

export default defineFake<FsPort>((init) => {
  const files = new Map(Object.entries((init as any)?.files ?? {}));
  return {
    instance: { async read(p) { return files.get(p) ?? null; }, /* … */ },
    snapshot: () => ({ files: Object.fromEntries([...files].sort()) }),
  };
});
```

- Fakes are **authoritative**: you write them, and the model never sees or edits them.
- Within one example, the same name always refers to the same instance.
- For `void` functions, `expected` is not allowed (the type forbids it), so `fakesAfter` is the assertion.

Effects are passed in as parameters (ports), never reached as globals. That's what makes them fakeable, and why `process`, `fetch`, `fs` and similar are forbidden inside regions.
