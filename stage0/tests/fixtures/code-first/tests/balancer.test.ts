import * as arc from "open-arc";
import { RoundRobin, hash32, type Backend } from "../src/lb/balancer.ts";

const three: Backend[] = [
  { id: "a", healthy: true, weight: 1 },
  { id: "b", healthy: true, weight: 1 },
  { id: "c", healthy: true, weight: 1 },
];

arc.test(RoundRobin, "rotates in list order and wraps", (RR, expect) => {
  const rr = new RR(three);
  expect(rr.pick("x")).toBe("a");
  expect(rr.pick("x")).toBe("b");
  expect(rr.pick("x")).toBe("c");
  expect(rr.pick("x")).toBe("a");
});

arc.test(RoundRobin, "no healthy backend gives null", (RR, expect) => {
  expect(new RR([]).pick("k")).toBe(null);
  expect(new RR([{ id: "a", healthy: false, weight: 1 }]).pick("k")).toBe(null);
});

arc.test(RoundRobin, "markDown skips the backend and keeps the position", (RR, expect) => {
  const rr = new RR(three);
  expect(rr.pick("x")).toBe("a");
  rr.markDown("b");
  expect(rr.pick("x")).toBe("c");
  expect(rr.healthy().map((b) => b.id)).toEqual(["a", "c"]);
});

arc.test(RoundRobin, "markDown of an unknown id throws", (RR, expect) => {
  expect(() => new RR(three).markDown("z")).toThrow("unknown backend z");
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
  const backends = gen.array((g) => ({ id: `b${n++}`, healthy: g.bool(), weight: 1 }), { max: 6 });
  const rr = new RR(backends);
  for (let i = 0; i < 10; i++) {
    const id = rr.pick("k");
    expect(id === null ? !backends.some((b) => b.healthy) : backends.some((b) => b.id === id && b.healthy)).toBe(true);
  }
});

arc.test(hash32, "known values", (h, expect) => {
  expect(h("")).toBe(2166136261);
  expect(h("a")).toBe(3826002220);
});
