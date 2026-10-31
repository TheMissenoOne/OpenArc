import * as arc from "open-arc";
import { ConsistentHash, LeastConnections, RoundRobin, hash32, type Backend } from "../src/lb/balancer.ts";

const node = (id: string, connections = 0, healthy = true): Backend => ({ id, healthy, connections });
const three = [node("a"), node("b"), node("c")];

arc.test(RoundRobin, "rotates in list order and wraps", (RR, expect) => {
  const rr = new RR(three);
  expect(["1", "2", "3", "4"].map((k) => rr.pick(k))).toEqual(["a", "b", "c", "a"]);
});

arc.test(RoundRobin, "markDown skips the backend and keeps the position", (RR, expect) => {
  const rr = new RR(three);
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

arc.test(LeastConnections, "picks the minimum, then counts it", (LC, expect) => {
  const lb = new LC([node("a", 5), node("b", 1), node("c", 3)]);
  expect(["1", "2", "3", "4"].map((k) => lb.pick(k))).toEqual(["b", "b", "b", "c"]);
});

arc.test(ConsistentHash, "a key sticks to its backend; removing one moves only its keys", (CH, expect) => {
  const before = new CH(three);
  const after = new CH(three);
  after.markDown("b");
  for (let i = 0; i < 100; i++) {
    const key = `user-${i}`;
    const was = before.pick(key);
    expect(before.pick(key)).toBe(was);
    if (was !== "b") expect(after.pick(key)).toBe(was);
    else expect(after.pick(key)).toMatch(/^[ac]$/);
  }
});

// Laws: a property checked on 50 seeded inputs per run of the compiler.
arc.law(RoundRobin, "never routes to an unhealthy backend", (RR, expect, gen) => {
  let n = 0;
  const backends = gen.array((g) => node(`b${n++}`, 0, g.bool()), { max: 6 });
  const rr = new RR(backends);
  for (let i = 0; i < 8; i++) {
    const id = rr.pick(`k${i}`);
    expect(id === null ? !backends.some((b) => b.healthy) : backends.some((b) => b.id === id && b.healthy)).toBe(true);
  }
});

arc.law(LeastConnections, "never routes to an unhealthy backend", (LC, expect, gen) => {
  let n = 0;
  const backends = gen.array((g) => node(`b${n++}`, g.int(0, 5), g.bool()), { max: 6 });
  const lb = new LC(backends);
  for (let i = 0; i < 8; i++) {
    const id = lb.pick(`k${i}`);
    expect(id === null ? !backends.some((b) => b.healthy) : backends.some((b) => b.id === id && b.healthy)).toBe(true);
  }
});

arc.test(hash32, "known values", (h, expect) => {
  expect(h("")).toBe(2166136261);
  expect(h("foobar")).toBe(3214735720);
});
