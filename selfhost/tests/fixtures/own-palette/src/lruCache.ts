// The code-first part of docs/wiki/Palette.md ("Code-first pieces in your palette"), verbatim: tests/own-palette.check.ts
// type-checks it as written, pending bodies included.
import * as arc from "open-arc";

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
