// Your own palette: a `cache` concept with two variants, as a project (or a package of yours) would write it.
// The concept is the contract (an interface type, an intent and laws); every variant runs the laws with its own
// fixtures. The bodies are hand-written here so tests/own-palette.check.ts can run them; in your project they can be
// pending (`export const lru: CacheRun = (config, ops) => arc.todo("cache.lru");`) for OpenArc to compile.
// The wiki page docs/wiki/Palette.md shows this file.
import * as arc from "open-arc";

/** One operation on the cache. `tick` advances the cache's clock by `ms`. */
export type Op = { op: "set"; key: string; value: string } | { op: "get"; key: string } | { op: "size" } | { op: "tick"; ms: number };
/** What a `get` (the value, or null on a miss) or a `size` (the number of live entries) answers; set and tick answer nothing. */
export type Reply = string | number | null;
export interface CacheConfig {
  capacity: number;
  ttlMs?: number;
}
/** The concept's interface: run `ops` in order against a new, empty cache whose clock starts at 0. */
export type CacheRun = (config: CacheConfig, ops: Op[]) => Reply[];

export const cacheConcept = arc.defineConcept({
  id: "cache",
  interface: "CacheRun",
  intent: "A bounded key-value cache: never more than config.capacity live entries; a get answers the last value set for its key unless the entry was evicted or expired.",
  laws: [
    {
      name: "get after set returns the value",
      args: ["$fixture:small", [{ op: "set", key: "a", value: "1" }, { op: "set", key: "a", value: "2" }, { op: "get", key: "a" }]],
      expected: ["2"],
    },
    {
      name: "eviction bound: never more entries than capacity",
      args: ["$fixture:small", [{ op: "set", key: "a", value: "1" }, { op: "set", key: "b", value: "2" }, { op: "set", key: "c", value: "3" }, { op: "size" }]],
      expected: [2],
    },
  ],
});

export const lruSpec = arc.defineRegion<CacheRun>({
  id: "cache.lru",
  concept: "cache",
  intent: "Least recently used: when full, a set evicts the entry that was set or read longest ago. Ignores ttlMs.",
  fixtures: { small: { capacity: 2 } },
  examples: [
    {
      name: "a get makes the entry recent",
      args: [{ capacity: 2 }, [{ op: "set", key: "a", value: "1" }, { op: "set", key: "b", value: "2" }, { op: "get", key: "a" }, { op: "set", key: "c", value: "3" }, { op: "get", key: "a" }, { op: "get", key: "b" }]],
      expected: ["1", "1", null],
    },
    { name: "a miss is null", args: [{ capacity: 1 }, [{ op: "get", key: "x" }, { op: "size" }]], expected: [null, 0] },
  ],
});

// @openarc:begin cache.lru
export const lru: CacheRun = (config, ops) => {
  const entries = new Map<string, string>(); // insertion order is recency order: the first key is the least recent
  const out: Reply[] = [];
  for (const o of ops) {
    if (o.op === "set") {
      entries.delete(o.key);
      entries.set(o.key, o.value);
      if (entries.size > config.capacity) entries.delete(entries.keys().next().value!);
    } else if (o.op === "get") {
      const v = entries.get(o.key);
      if (v !== undefined) {
        entries.delete(o.key);
        entries.set(o.key, v);
      }
      out.push(v ?? null);
    } else if (o.op === "size") out.push(entries.size);
  }
  return out;
};
// @openarc:end cache.lru

export const ttlSpec = arc.defineRegion<CacheRun>({
  id: "cache.ttl",
  concept: "cache",
  intent: "Time to live: an entry expires ttlMs after it was set (never when ttlMs is absent); when full, a set evicts the oldest entry. A get doesn't refresh an entry.",
  fixtures: { small: { capacity: 2, ttlMs: 1000 } },
  examples: [
    {
      name: "an entry expires ttlMs after it was set",
      args: [{ capacity: 2, ttlMs: 100 }, [{ op: "set", key: "a", value: "1" }, { op: "tick", ms: 99 }, { op: "get", key: "a" }, { op: "tick", ms: 1 }, { op: "get", key: "a" }, { op: "size" }]],
      expected: ["1", null, 0],
    },
    {
      name: "full: the oldest entry goes, reads don't refresh it",
      args: [{ capacity: 2, ttlMs: 100 }, [{ op: "set", key: "a", value: "1" }, { op: "set", key: "b", value: "2" }, { op: "get", key: "a" }, { op: "set", key: "c", value: "3" }, { op: "get", key: "a" }, { op: "get", key: "b" }]],
      expected: ["1", null, "2"],
    },
  ],
});

// @openarc:begin cache.ttl
export const ttl: CacheRun = (config, ops) => {
  const entries = new Map<string, { value: string; expires: number }>(); // insertion order: the first key is the oldest
  const ttlMs = config.ttlMs ?? Infinity;
  let now = 0;
  const out: Reply[] = [];
  for (const o of ops) {
    for (const [k, e] of entries) if (e.expires <= now) entries.delete(k);
    if (o.op === "tick") now += o.ms;
    else if (o.op === "set") {
      entries.delete(o.key);
      entries.set(o.key, { value: o.value, expires: now + ttlMs });
      if (entries.size > config.capacity) entries.delete(entries.keys().next().value!);
    } else if (o.op === "get") out.push(entries.get(o.key)?.value ?? null);
    else out.push(entries.size);
  }
  return out;
};
// @openarc:end cache.ttl
