// A load-balanced service: every request applies the latest health probes, routes by consistent hash over the healthy
// backends, and fails over to the others. Written as a sketch over the loadBalancer palette.
import * as arc from "open-arc";
import * as lb from "../palette/loadBalancer.ts";

export const POLICY: lb.HealthPolicy = { unhealthyAfter: 2, healthyAfter: 2, minDownMs: 10_000 };
export type ServeResult = { health: lb.HealthState[]; result: lb.FailoverResult };
type Serve = (pool: lb.Backend[], health: lb.HealthState[], probes: lb.Probe[], clock: lb.Clock, request: string, upstream: lb.Upstream) => Promise<ServeResult>;

export const serveSpec = arc.defineRegion<Serve>({
  id: "app.serve",
  examples: [
    {
      name: "a request lands on its consistent-hash backend",
      args: [
        [{ id: "a", healthy: true, weight: 1, connections: 0 }, { id: "b", healthy: true, weight: 1, connections: 0 }, { id: "c", healthy: true, weight: 1, connections: 0 }],
        [{ id: "a", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "b", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "c", healthy: true, failures: 0, successes: 0, downSince: null }],
        [], { $fake: "palette.clock", init: { now: 0 } }, "GET /cart/3", { $fake: "palette.upstream", init: {} },
      ],
      expected: {
        health: [{ id: "a", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "b", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "c", healthy: true, failures: 0, successes: 0, downSince: null }],
        result: { ok: true, backend: "b", body: "b:GET /cart/3", attempts: 1 },
      },
    },
    {
      name: "a failed health check reroutes before sending",
      args: [
        [{ id: "a", healthy: true, weight: 1, connections: 0 }, { id: "b", healthy: true, weight: 1, connections: 0 }, { id: "c", healthy: true, weight: 1, connections: 0 }],
        [{ id: "a", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "b", healthy: true, failures: 1, successes: 0, downSince: null }, { id: "c", healthy: true, failures: 0, successes: 0, downSince: null }],
        [{ id: "b", ok: false }], { $fake: "palette.clock", init: { now: 5000 } }, "GET /cart/3", { $fake: "palette.upstream", init: {} },
      ],
      expected: {
        health: [{ id: "a", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "b", healthy: false, failures: 2, successes: 0, downSince: 5000 }, { id: "c", healthy: true, failures: 0, successes: 0, downSince: null }],
        result: { ok: true, backend: "a", body: "a:GET /cart/3", attempts: 1 },
      },
      fakesAfter: { "palette.upstream": { sent: ["a"] } },
    },
    {
      name: "a dead backend fails over to the next healthy one",
      args: [
        [{ id: "a", healthy: true, weight: 1, connections: 0 }, { id: "b", healthy: true, weight: 1, connections: 0 }, { id: "c", healthy: true, weight: 1, connections: 0 }],
        [{ id: "a", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "b", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "c", healthy: true, failures: 0, successes: 0, downSince: null }],
        [], { $fake: "palette.clock", init: { now: 0 } }, "GET /cart/3", { $fake: "palette.upstream", init: { dead: ["b"] } },
      ],
      expected: {
        health: [{ id: "a", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "b", healthy: true, failures: 0, successes: 0, downSince: null }, { id: "c", healthy: true, failures: 0, successes: 0, downSince: null }],
        result: { ok: true, backend: "a", body: "a:GET /cart/3", attempts: 2 },
      },
      fakesAfter: { "palette.upstream": { sent: ["b", "a"] } },
    },
    {
      name: "nothing healthy",
      args: [
        [{ id: "a", healthy: true, weight: 1, connections: 0 }],
        [{ id: "a", healthy: false, failures: 0, successes: 0, downSince: 0 }],
        [], { $fake: "palette.clock", init: { now: 0 } }, "GET /", { $fake: "palette.upstream", init: {} },
      ],
      expected: { health: [{ id: "a", healthy: false, failures: 0, successes: 0, downSince: 0 }], result: { ok: false, error: "no backend", attempts: 0 } },
    },
  ],
  sketch: async (pool, health, probes, clock, request, upstream) => {
    const next = lb.healthCheck(health, probes, clock, POLICY);
    const live = pool.map((b) => ({ ...b, healthy: next.find((h) => h.id === b.id)?.healthy ?? b.healthy }));
    const [first] = lb.consistentHash(live, [request]);
    const order = arc.hole<string[]>("first (when it isn't null), then the other healthy backends of live in pool order, without repeating first");
    return { health: next, result: await lb.failover(order, request, upstream, order.length) };
  },
});

// @openarc:begin app.serve
export const serve: Serve = (pool, health, probes, clock, request, upstream) => arc.todo("app.serve");
// @openarc:end app.serve
