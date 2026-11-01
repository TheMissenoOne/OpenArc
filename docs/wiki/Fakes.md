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

## Fakes in code-first tests

In an `arc.test`, ask for a fake by its port's type: `const net = fakes.of<Transport>()` (optionally `fakes.of<Transport>(init)`). The compiler finds the one `export default defineFake<Transport>(…)` in `tests/fakes/` when it reads the test, and names it in the sandbox's copy; none, or two, is `OARC-E010` (detail `fake:Transport`, `fake:Transport:ambiguous`). `fakes.named("net.memory", init)` picks one by file name, and `fakes.snapshot(net)` returns that instance's `snapshot()`, which replaces `fakesAfter`:

```ts
arc.test(Peer, "forwards once, with one hop less", async (P, expect, fakes) => {
  const net = fakes.of<Transport>();
  const a = new P("a", ["d", "b", "c"], net);
  expect(await a.receive(null, { id: "g1", origin: "a", ttl: 2, body: "hi" })).toBe(true);
  expect(fakes.snapshot(net)).toEqual({ sent: [["a", "b", "g1", 1], ["a", "c", "g1", 1]] });
});
```
