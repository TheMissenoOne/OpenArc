// OpenArc palette: load balancer. A strategy concept with four variants (round-robin, least-connections, weighted,
// consistent-hash), plus health checks and failover. See README.md.
// Strategies are pure: a batch of requests in, one backend id per request out, with the backends' state (health,
// weight, open connections) as input. Time reaches health checks through a clock port; requests reach backends
// through an upstream port.
import * as arc from "open-arc";

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export interface Backend {
  id: string;
  healthy: boolean;
  weight: number; // >= 1; only `weighted` uses it
  connections: number; // open connections now; only `leastConnections` uses it
}
/** The concept's interface: route `keys` (one per request, in order) to backend ids; null when nothing is healthy.
 * @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette).
 */
export type Strategy = (backends: Backend[], keys: string[]) => (string | null)[];
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export interface Clock {
  now(): number;
}

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const strategyConcept = arc.defineConcept({
  id: "lbStrategy",
  interface: "Strategy",
  intent: [
    "Route a batch of requests to backends: one backend id per key, in order. Only healthy backends are eligible; with none, every request gets null.",
    "Pure and deterministic: the result depends only on the arguments. Requests earlier in the batch count as routed when later ones are placed.",
  ],
  laws: [
    {
      name: "never route to an unhealthy backend",
      args: [[{ id: "a", healthy: false, weight: 5, connections: 0 }, { id: "b", healthy: true, weight: 1, connections: 9 }, { id: "c", healthy: false, weight: 1, connections: 0 }], ["k1", "k2", "k3", "k4"]],
      expected: ["b", "b", "b", "b"],
    },
    {
      name: "no healthy backend: every request gets null",
      args: [[{ id: "a", healthy: false, weight: 1, connections: 0 }, { id: "b", healthy: false, weight: 1, connections: 0 }], ["k1", "k2"]],
      expected: [null, null],
    },
    { name: "no backends at all", args: [[], ["k1"]], expected: [null] },
    { name: "an empty batch routes nothing", args: [[{ id: "a", healthy: true, weight: 1, connections: 0 }], []], expected: [] },
    {
      name: "equal backends share requests evenly",
      args: [[{ id: "a", healthy: true, weight: 1, connections: 0 }, { id: "b", healthy: true, weight: 1, connections: 0 }, { id: "c", healthy: true, weight: 1, connections: 0 }], ["k1", "k2", "k3", "k4", "k5", "k6"]],
      expected: ["a", "b", "c", "a", "b", "c"],
    },
  ],
});

// ── lb.roundRobin ─────────────────────────────────────────────── variant
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const roundRobinSpec = arc.defineRegion<Strategy>({
  id: "lb.roundRobin",
  concept: "lbStrategy",
  intent: "The i-th request goes to the (i mod n)-th healthy backend, in list order (n = number of healthy backends). Keys are ignored.",
  examples: [
    {
      name: "round-robin is fair over N picks",
      args: [[{ id: "a", healthy: true, weight: 1, connections: 7 }, { id: "b", healthy: true, weight: 9, connections: 0 }], ["x", "x", "x", "x"]],
      expected: ["a", "b", "a", "b"],
    },
    {
      name: "an unhealthy backend is skipped in the rotation",
      args: [[{ id: "a", healthy: true, weight: 1, connections: 0 }, { id: "b", healthy: false, weight: 1, connections: 0 }, { id: "c", healthy: true, weight: 1, connections: 0 }], ["1", "2", "3"]],
      expected: ["a", "c", "a"],
    },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin lb.roundRobin
export const roundRobin: Strategy = (backends, keys) => {
  const healthy = backends.filter((b) => b.healthy);
  return keys.map((_, i) => (healthy.length ? healthy[i % healthy.length]!.id : null));
};
// @openarc:end lb.roundRobin

// ── lb.leastConnections ───────────────────────────────────────── variant
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const leastConnectionsSpec = arc.defineRegion<Strategy>({
  id: "lb.leastConnections",
  concept: "lbStrategy",
  intent: "Each request goes to the healthy backend with the fewest connections (ties: the first in list order), which then has one more connection for the rest of the batch.",
  examples: [
    {
      name: "least-connections picks the minimum",
      args: [[{ id: "a", healthy: true, weight: 1, connections: 5 }, { id: "b", healthy: true, weight: 1, connections: 1 }, { id: "c", healthy: true, weight: 1, connections: 3 }], ["1", "2", "3", "4"]],
      expected: ["b", "b", "b", "c"],
    },
    {
      name: "a busy unhealthy backend is still skipped",
      args: [[{ id: "a", healthy: false, weight: 1, connections: 0 }, { id: "b", healthy: true, weight: 1, connections: 2 }, { id: "c", healthy: true, weight: 1, connections: 2 }], ["1", "2"]],
      expected: ["b", "c"],
    },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin lb.leastConnections
export const leastConnections: Strategy = (backends, keys) => {
  const open = new Map(backends.filter((b) => b.healthy).map((b) => [b.id, b.connections]));
  return keys.map(() => {
    let best: string | null = null;
    for (const [id, n] of open) if (best === null || n < open.get(best)!) best = id;
    if (best !== null) open.set(best, open.get(best)! + 1);
    return best;
  });
};
// @openarc:end lb.leastConnections

// ── lb.weighted ───────────────────────────────────────────────── variant
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const weightedSpec = arc.defineRegion<Strategy>({
  id: "lb.weighted",
  concept: "lbStrategy",
  intent: [
    "Smooth weighted round-robin (nginx): every healthy backend starts at current = 0. Per request: add each backend's weight to its current,",
    "pick the largest current (ties: first in list order), subtract the total weight of the healthy backends from the pick's current.",
  ],
  examples: [
    {
      name: "weights 5:1:1 interleave smoothly",
      args: [[{ id: "a", healthy: true, weight: 5, connections: 0 }, { id: "b", healthy: true, weight: 1, connections: 0 }, { id: "c", healthy: true, weight: 1, connections: 0 }], ["1", "2", "3", "4", "5", "6", "7"]],
      expected: ["a", "a", "b", "a", "c", "a", "a"],
    },
    {
      name: "weights 2:1 over one cycle",
      args: [[{ id: "a", healthy: true, weight: 2, connections: 0 }, { id: "b", healthy: true, weight: 1, connections: 0 }], ["1", "2", "3"]],
      expected: ["a", "b", "a"],
    },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin lb.weighted
export const weighted: Strategy = (backends, keys) => {
  const healthy = backends.filter((b) => b.healthy);
  const total = healthy.reduce((s, b) => s + b.weight, 0);
  const current = healthy.map(() => 0);
  return keys.map(() => {
    if (!healthy.length) return null;
    let best = 0;
    for (let i = 0; i < healthy.length; i++) {
      current[i]! += healthy[i]!.weight;
      if (current[i]! > current[best]!) best = i;
    }
    current[best]! -= total;
    return healthy[best]!.id;
  });
};
// @openarc:end lb.weighted

// ── lb.hash32 ─────────────────────────────────────────────────── the hash consistentHash places keys with
type Hash32 = (text: string) => number;

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const hash32Spec = arc.defineRegion<Hash32>({
  id: "lb.hash32",
  intent: [
    "32-bit FNV-1a over the UTF-16 code units of text (h = 2166136261; per unit: h = Math.imul(h ^ unit, 16777619) >>> 0),",
    "then murmur3's fmix32 finalizer so similar keys spread over the ring: h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16. Unsigned result.",
  ],
  examples: [
    { args: [""], expected: 2872998923 },
    { args: ["a"], expected: 444641715 },
    { args: ["foobar"], expected: 202221276 },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin lb.hash32
export const hash32: Hash32 = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};
// @openarc:end lb.hash32

// ── lb.consistentHash ─────────────────────────────────────────── variant, written as a sketch
/** Virtual nodes per backend on the hash ring.
 * @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette).
 */
export const REPLICAS = 64;

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const consistentHashSpec = arc.defineRegion<Strategy>({
  id: "lb.consistentHash",
  concept: "lbStrategy",
  intent: "A hash ring: each healthy backend owns REPLICAS points. A key goes to the owner of the first point at or after hash32(key), wrapping around.",
  waive: { "equal backends share requests evenly": "hashing pins each key to a backend, so the spread is statistical, not even per batch" },
  examples: [
    {
      name: "the same key always lands on the same backend",
      args: [[{ id: "a", healthy: true, weight: 1, connections: 0 }, { id: "b", healthy: true, weight: 1, connections: 0 }, { id: "c", healthy: true, weight: 1, connections: 0 }], ["user-1", "user-2", "user-3", "user-4", "user-1", "user-5"]],
      expected: ["b", "b", "c", "a", "b", "a"],
    },
    {
      name: "removing a node moves only the keys it owned",
      args: [[{ id: "a", healthy: true, weight: 1, connections: 0 }, { id: "b", healthy: false, weight: 1, connections: 0 }, { id: "c", healthy: true, weight: 1, connections: 0 }], ["user-1", "user-2", "user-3", "user-4", "user-1", "user-5"]],
      expected: ["c", "c", "c", "a", "c", "a"],
    },
  ],
  sketch: (backends, keys) => {
    const ring = backends
      .filter((b) => b.healthy)
      .flatMap((b) => Array.from({ length: REPLICAS }, (_, i) => ({ at: hash32(`${b.id}#${i}`), id: b.id })))
      .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return keys.map((key) => {
      const h = hash32(key);
      return arc.hole<string | null>("the id of the first ring entry with at >= h, else ring[0]; null when the ring is empty");
    });
  },
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin lb.consistentHash
export const consistentHash: Strategy = (backends, keys) => {
  const ring = backends
    .filter((b) => b.healthy)
    .flatMap((b) => Array.from({ length: REPLICAS }, (_, i) => ({ at: hash32(`${b.id}#${i}`), id: b.id })))
    .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return keys.map((key) => {
    const h = hash32(key);
    return ((ring.find((p) => p.at >= h) ?? ring[0])?.id ?? null);
  });
};
// @openarc:end lb.consistentHash

// ── lb.healthCheck ────────────────────────────────────────────── passive health checks, time from a clock port
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export interface HealthState {
  id: string;
  healthy: boolean;
  failures: number; // consecutive failed probes
  successes: number; // consecutive passed probes
  downSince: number | null; // when it went unhealthy (clock ms)
}
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export interface Probe {
  id: string;
  ok: boolean;
}
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export interface HealthPolicy {
  unhealthyAfter: number; // consecutive failures that take a backend out
  healthyAfter: number; // consecutive successes that bring it back...
  minDownMs: number; // ...but not before it has been out this long
}
type HealthCheck = (states: HealthState[], probes: Probe[], clock: Clock, policy: HealthPolicy) => HealthState[];

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const healthCheckSpec = arc.defineRegion<HealthCheck>({
  id: "lb.healthCheck",
  intent: [
    "Apply one round of probe results. A backend without a probe is unchanged. A passed probe adds a success and resets failures; a failed one adds a failure and resets successes.",
    "Healthy -> unhealthy when failures >= policy.unhealthyAfter (downSince = clock.now()). Unhealthy -> healthy when successes >= policy.healthyAfter and clock.now() - downSince >= policy.minDownMs (downSince = null).",
    "An unhealthy state with downSince null starts its cool-down now: downSince = clock.now(), never time 0.",
    "Return new objects in the input order; never mutate the input.",
  ],
  examples: [
    {
      name: "the third failure takes a backend out",
      args: [[{ id: "a", healthy: true, failures: 2, successes: 0, downSince: null }, { id: "b", healthy: true, failures: 0, successes: 4, downSince: null }], [{ id: "a", ok: false }, { id: "b", ok: true }], { $fake: "palette.clock", init: { now: 1000 } }, { unhealthyAfter: 3, healthyAfter: 2, minDownMs: 500 }],
      expected: [{ id: "a", healthy: false, failures: 3, successes: 0, downSince: 1000 }, { id: "b", healthy: true, failures: 0, successes: 5, downSince: null }],
    },
    {
      name: "enough successes, but not out long enough yet",
      args: [[{ id: "a", healthy: false, failures: 0, successes: 1, downSince: 800 }], [{ id: "a", ok: true }], { $fake: "palette.clock", init: { now: 1000 } }, { unhealthyAfter: 3, healthyAfter: 2, minDownMs: 500 }],
      expected: [{ id: "a", healthy: false, failures: 0, successes: 2, downSince: 800 }],
    },
    {
      name: "back in after the cool-down",
      args: [[{ id: "a", healthy: false, failures: 0, successes: 1, downSince: 400 }], [{ id: "a", ok: true }], { $fake: "palette.clock", init: { now: 1000 } }, { unhealthyAfter: 3, healthyAfter: 2, minDownMs: 500 }],
      expected: [{ id: "a", healthy: true, failures: 0, successes: 2, downSince: null }],
    },
    {
      name: "no probe, no change; a failure resets successes",
      args: [[{ id: "a", healthy: true, failures: 0, successes: 3, downSince: null }, { id: "b", healthy: true, failures: 0, successes: 3, downSince: null }], [{ id: "b", ok: false }], { $fake: "palette.clock", init: { now: 0 } }, { unhealthyAfter: 3, healthyAfter: 2, minDownMs: 0 }],
      expected: [{ id: "a", healthy: true, failures: 0, successes: 3, downSince: null }, { id: "b", healthy: true, failures: 1, successes: 0, downSince: null }],
    },
    { name: "no backends", args: [[], [], { $fake: "palette.clock", init: { now: 0 } }, { unhealthyAfter: 1, healthyAfter: 1, minDownMs: 0 }], expected: [] },
    {
      name: "unhealthy without downSince starts its cool-down now",
      args: [[{ id: "a", healthy: false, failures: 0, successes: 1, downSince: null }], [{ id: "a", ok: true }], { $fake: "palette.clock", init: { now: 1000 } }, { unhealthyAfter: 3, healthyAfter: 2, minDownMs: 500 }],
      expected: [{ id: "a", healthy: false, failures: 0, successes: 2, downSince: 1000 }],
    },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin lb.healthCheck
export const healthCheck: HealthCheck = (states, probes, clock, policy) =>
  states.map((s) => {
    const probe = probes.find((p) => p.id === s.id);
    if (!probe) return { ...s };
    const next: HealthState = probe.ok ? { ...s, successes: s.successes + 1, failures: 0 } : { ...s, failures: s.failures + 1, successes: 0 };
    if (next.healthy && next.failures >= policy.unhealthyAfter) return { ...next, healthy: false, downSince: clock.now() };
    if (next.healthy) return next;
    const downSince = next.downSince ?? clock.now();
    if (next.successes >= policy.healthyAfter && clock.now() - downSince >= policy.minDownMs) return { ...next, healthy: true, downSince: null };
    return { ...next, downSince };
  });
// @openarc:end lb.healthCheck

// ── lb.failover ───────────────────────────────────────────────── try backends in order until one answers
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export type UpstreamReply = { ok: true; body: string } | { ok: false; error: string };
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export interface Upstream {
  /** Send one request to one backend. May reject (connection refused, timeout). */
  send(backend: string, request: string): Promise<UpstreamReply>;
}
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export type FailoverResult = { ok: true; backend: string; body: string; attempts: number } | { ok: false; error: string; attempts: number };
type Failover = (order: string[], request: string, upstream: Upstream, maxAttempts: number) => Promise<FailoverResult>;

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const failoverSpec = arc.defineRegion<Failover>({
  id: "lb.failover",
  intent: "Send the request to the backends in `order` (a strategy's choice first, then the fallbacks), one at a time, until one answers ok or maxAttempts sends were made.",
  examples: [
    { name: "the first backend answers", args: [["a", "b"], "GET /", { $fake: "palette.upstream", init: {} }, 3], expected: { ok: true, backend: "a", body: "a:GET /", attempts: 1 }, fakesAfter: { "palette.upstream": { sent: ["a"] } } },
    { name: "fails over past an error and a dead backend", args: [["a", "b", "c"], "GET /", { $fake: "palette.upstream", init: { down: ["a"], dead: ["b"] } }, 3], expected: { ok: true, backend: "c", body: "c:GET /", attempts: 3 }, fakesAfter: { "palette.upstream": { sent: ["a", "b", "c"] } } },
    { name: "gives up after maxAttempts", args: [["a", "b", "c"], "GET /", { $fake: "palette.upstream", init: { down: ["a"], dead: ["b"] } }, 2], expected: { ok: false, error: "b: connection refused", attempts: 2 }, fakesAfter: { "palette.upstream": { sent: ["a", "b"] } } },
    { name: "nothing to try", args: [[], "GET /", { $fake: "palette.upstream", init: {} }, 3], expected: { ok: false, error: "no backend", attempts: 0 } },
  ],
  sketch: async (order, request, upstream, maxAttempts) => {
    let attempts = 0;
    let lastError = "no backend";
    for (const backend of order) {
      if (attempts >= maxAttempts) break;
      attempts++;
      const reply: UpstreamReply = await upstream.send(backend, request).catch((e: unknown) => ({ ok: false as const, error: arc.hole<string>("e's message when e is an Error, else String(e)") }));
      if (reply.ok) return { ok: true, backend, body: reply.body, attempts };
      lastError = reply.error;
    }
    return { ok: false, error: lastError, attempts };
  },
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin lb.failover
export const failover: Failover = async (order, request, upstream, maxAttempts) => {
  let attempts = 0;
  let lastError = "no backend";
  for (const backend of order) {
    if (attempts >= maxAttempts) break;
    attempts++;
    const reply: UpstreamReply = await upstream.send(backend, request).catch((e: unknown) => ({ ok: false as const, error: (e instanceof Error ? e.message : String(e)) }));
    if (reply.ok) return { ok: true, backend, body: reply.body, attempts };
    lastError = reply.error;
  }
  return { ok: false, error: lastError, attempts };
};
// @openarc:end lb.failover
