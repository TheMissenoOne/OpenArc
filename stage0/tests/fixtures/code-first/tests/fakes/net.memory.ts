import { defineFake } from "open-arc";
import type { Gossip, Transport } from "../../src/p2p/peer.ts";

/** Records every send as [from, to, id, ttl]. */
export default defineFake<Transport>(() => {
  const sent: [string, string, string, number][] = [];
  const instance: Transport = {
    async send(from: string, to: string, msg: Gossip) {
      sent.push([from, to, msg.id, msg.ttl]);
    },
  };
  return { instance, snapshot: () => ({ sent }) };
});
