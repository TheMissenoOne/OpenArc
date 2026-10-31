// Fake upstream for lb.failover: every backend answers "<backend>:<request>", except those in `down` (an error reply,
// "<backend>: 503") and `dead` (the send rejects, "<backend>: connection refused").
// init: { down?: string[], dead?: string[] }. snapshot(): { sent: backend ids in order }.
import { defineFake } from "open-arc";
import type { Upstream } from "../../src/palette/loadBalancer.ts";

export default defineFake<Upstream>((init) => {
  const i = (init ?? {}) as { down?: string[]; dead?: string[] };
  const sent: string[] = [];
  const instance: Upstream = {
    async send(backend, request) {
      sent.push(backend);
      if (i.dead?.includes(backend)) throw new Error(`${backend}: connection refused`);
      if (i.down?.includes(backend)) return { ok: false, error: `${backend}: 503` };
      return { ok: true, body: `${backend}:${request}` };
    },
  };
  return { instance, snapshot: () => ({ sent }) };
});
