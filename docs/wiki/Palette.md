# Building your own palette

A palette is a library of reusable concepts: building blocks written as **structure** (types, laws, examples, sketches, code-first classes and tests) instead of prose prompts. OpenArc gives you the machinery; the concepts are yours. Write them in your project, or in a package of your own that exports concepts and helpers, and import them like any module.

Everything on this page is fully supported:

| Piece | What it gives your palette | Docs |
|---|---|---|
| `arc.defineConcept` | one contract (an interface type, an intent, **laws**) that every variant must pass | below, [[Writing Specs]] |
| Variants | ordinary regions with `concept: "<id>"`, their own `fixtures`, examples and `waive` | below |
| Sketches, `arc.hole` | the structure of a body as code, with only the gaps left to the model | [[Writing Specs]] |
| Code-first classes, interfaces, tests | `return arc.todo();` in a member, `arc.test`, `arc.test.hidden` | [[Code First]] |
| `arc.law` | a property checked on seeded random inputs | [[Code First]] |
| Fakes | ports a law can count and inspect | [[Fakes]] |
| Modules | a concept and its helpers are exports: a user of a variant sees its signature and the concept's one-line summary, never its body | [[Context Packages]] |

## A worked example: a `cache` concept

A bounded key-value cache with two laws (get after set, eviction bound) and two variants (LRU and TTL). The variants are functions that run a list of operations against a new cache, so the laws can be plain JSON. The same file with hand-written bodies in place of the two pending ones is [`stage0/tests/fixtures/own-palette/src/cache.ts`](https://github.com/TheMissenoOne/OpenArc/blob/main/stage0/tests/fixtures/own-palette/src/cache.ts): `stage0/tests/own-palette.check.ts` type-checks it and runs every law and example against both variants.

```ts
// src/palette/cache.ts
import * as arc from "open-arc";

/** One operation on the cache. `tick` advances the cache's clock by `ms`. */
export type Op = { op: "set"; key: string; value: string } | { op: "get"; key: string } | { op: "size" } | { op: "tick"; ms: number };
/** What a `get` (the value, or null on a miss) or a `size` (the number of live entries) answers. */
export type Reply = string | number | null;
export interface CacheConfig { capacity: number; ttlMs?: number }
/** The concept's interface: run `ops` in order against a new, empty cache whose clock starts at 0. */
export type CacheRun = (config: CacheConfig, ops: Op[]) => Reply[];

export const cacheConcept = arc.defineConcept({
  id: "cache",
  interface: "CacheRun",            // every variant's F must be CacheRun (else OARC-E020)
  intent: "A bounded key-value cache: never more than config.capacity live entries; a get answers the last value set for its key unless the entry was evicted or expired.",
  laws: [
    { name: "get after set returns the value",
      args: ["$fixture:small", [{ op: "set", key: "a", value: "1" }, { op: "set", key: "a", value: "2" }, { op: "get", key: "a" }]],
      expected: ["2"] },
    { name: "eviction bound: never more entries than capacity",
      args: ["$fixture:small", [{ op: "set", key: "a", value: "1" }, { op: "set", key: "b", value: "2" }, { op: "set", key: "c", value: "3" }, { op: "size" }]],
      expected: [2] },
  ],
});

export const lruSpec = arc.defineRegion<CacheRun>({
  id: "cache.lru",
  concept: "cache",
  intent: "Least recently used: when full, a set evicts the entry that was set or read longest ago. Ignores ttlMs.",
  fixtures: { small: { capacity: 2 } },
  examples: [
    { name: "a get makes the entry recent",
      args: [{ capacity: 2 }, [{ op: "set", key: "a", value: "1" }, { op: "set", key: "b", value: "2" }, { op: "get", key: "a" },
                               { op: "set", key: "c", value: "3" }, { op: "get", key: "a" }, { op: "get", key: "b" }]],
      expected: ["1", "1", null] },
    { name: "a miss is null", args: [{ capacity: 1 }, [{ op: "get", key: "x" }, { op: "size" }]], expected: [null, 0] },
  ],
});
// @openarc:begin cache.lru
export const lru: CacheRun = (config, ops) => arc.todo("cache.lru");
// @openarc:end cache.lru

export const ttlSpec = arc.defineRegion<CacheRun>({
  id: "cache.ttl",
  concept: "cache",
  intent: "Time to live: an entry expires ttlMs after it was set (never when ttlMs is absent); when full, a set evicts the oldest entry. A get doesn't refresh an entry.",
  fixtures: { small: { capacity: 2, ttlMs: 1000 } },
  examples: [
    { name: "an entry expires ttlMs after it was set",
      args: [{ capacity: 2, ttlMs: 100 }, [{ op: "set", key: "a", value: "1" }, { op: "tick", ms: 99 }, { op: "get", key: "a" },
                                           { op: "tick", ms: 1 }, { op: "get", key: "a" }, { op: "size" }]],
      expected: ["1", null, 0] },
    { name: "full: the oldest entry goes, reads don't refresh it",
      args: [{ capacity: 2, ttlMs: 100 }, [{ op: "set", key: "a", value: "1" }, { op: "set", key: "b", value: "2" }, { op: "get", key: "a" },
                                           { op: "set", key: "c", value: "3" }, { op: "get", key: "a" }, { op: "get", key: "b" }]],
      expected: ["1", null, "2"] },
  ],
});
// @openarc:begin cache.ttl
export const ttl: CacheRun = (config, ops) => arc.todo("cache.ttl");
// @openarc:end cache.ttl
```

What happens:

- **Laws become examples.** Each variant gets `law: get after set returns the value` and `law: eviction bound: never more entries than capacity` as its first examples, with `"$fixture:small"` replaced by its own fixture: `{ capacity: 2 }` for LRU, `{ capacity: 2, ttlMs: 1000 }` for TTL. Laws are authoritative, like your own examples.
- **Laws have teeth.** An LRU body that forgets to evict passes "get after set" but fails `law: eviction bound` (and "a get makes the entry recent"), so it is never committed. `own-palette.check.ts` checks exactly that.
- **Variant examples carry the rest:** LRU's recency, TTL's expiry and its oldest-first eviction.
- **A law that can't apply** to a variant gets `waive: { "<law>": "<reason>" }`; the reason is printed when the variant compiles and stored in the manifest.
- **Users see the contract, not the code.** A region that imports `lru` sees its signature plus `// variant of concept cache: <intent> Laws: …`.

To add a variant, write a region with `concept: "cache"` and the fixtures the laws name; the laws come with it. Make laws about what every variant must do, and give them teeth through fakes when a variant has effects: a fake that counts calls turns "uses a constant-time compare" into an exact expectation (see [[Fakes]]).

## Code-first pieces in your palette

Classes, interfaces and tests in your palette are plain code-first TypeScript (see [[Code First]]): an interface is the contract, a class implements it with `return arc.todo();` in the members you want written, and `arc.test` / `arc.law` check it.

```ts
/** A bounded cache. */
export interface Cache {
  get(key: string): string | null;
  set(key: string, value: string): void;
  readonly size: number;
}

export class LruCache implements Cache {
  readonly entries = new Map<string, string>();
  readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  get size(): number { return this.entries.size; }
  /** The value, made most recent; null on a miss. */
  get(key: string): string | null { return arc.todo(); }
  /** Store the value; when over capacity, drop the least recently used entry. */
  set(key: string, value: string): void { return arc.todo(); }
}

arc.law(LruCache, "eviction bound", (C, expect, gen) => {
  const c = new C(gen.int(1, 4));
  for (const k of gen.array((g) => g.string({ max: 3 }), { max: 20 })) c.set(k, "v");
  expect(c.size <= c.capacity).toBe(true);
});
```

This class is [`stage0/tests/fixtures/own-palette/src/lruCache.ts`](https://github.com/TheMissenoOne/OpenArc/blob/main/stage0/tests/fixtures/own-palette/src/lruCache.ts) and type-checks as written, pending bodies included. `arc.law` targets one class. Laws over every implementation of an interface (`arc.law(arc.implementations<I>(), …)`) come in a later code-first phase; until then, a law shared by several implementations is a concept's law, as in the worked example.

## Sketches in your palette

When you know the shape of a variant, give its region a `sketch:` instead of a pending body: the body as typed code with `arc.hole<T>("…")` where you want the model. The model writes only the fills; the compiler splices them and checks that nothing else changed (`OARC-E099`), and every hole must be reached by a passing example (`OARC-W045`). Laws reach sketch variants like any other. See [[Writing Specs]].

## UI in your palette

The TSX UI spec mechanism (the static reader, the DOM harness, `"ui": { "dom": "jsdom" }`) is supported. Today it reads only the built-in `open-arc/ui` vocabulary (`Form`, `Field`, `ErrorText`, `Submit`), which is deprecated and frozen since 0.9.0: it keeps working unchanged. Project-defined vocabularies (atomic-design TSX with `arc.render`) come with code-first phase 5. See [[Writing Specs]].

## Bundled palette (deprecated, frozen)

OpenArc 0.8.0 shipped a palette: `open-arc/palette/auth` (concept `auth`: password, API key, magic link), `loadBalancer` (concept `lbStrategy`: round-robin, least connections, weighted, consistent hash; health checks, failover), `p2p` (concept `framing`: length-prefixed and varint decoders; handshake, peer table, gossip), and the `loginPage` UI spec, with fakes `palette.auth`, `palette.clock`, `palette.upstream`, `palette.net`. `examples/palette-demo/` uses it, and `stage0/tools/palette.ts` writes a pending copy into a project.

Since 0.9.0 it is **deprecated and frozen**: it keeps working and shipping with no behaviour changes, so code written against 0.8.0 still runs, and every exported symbol carries a JSDoc `@deprecated` tag. It won't grow: build the concepts you need as above. Its sources and laws are documented in [`stage0/src/palette/README.md`](https://github.com/TheMissenoOne/OpenArc/blob/main/stage0/src/palette/README.md).
