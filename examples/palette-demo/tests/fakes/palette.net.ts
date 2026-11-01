// Fake network for the p2p palette: N peers joined by undirected links; deliveries in FIFO order, so a multi-peer
// scenario is deterministic. A send over a missing link is dropped.
// init: { links: [peer, peer][] }. snapshot(): { log: "from>to id" per delivered send, in order, dropped: count }.
import { defineFake } from "open-arc";
import type { Gossip, Transport } from "../../src/palette/p2p.ts";

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export default defineFake<Transport>((init) => {
  const links = ((init ?? {}) as { links?: [string, string][] }).links ?? [];
  const linked = (a: string, b: string) => links.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const queue: { from: string; to: string; msg: Gossip }[] = [];
  const log: string[] = [];
  let dropped = 0;
  const instance: Transport = {
    async send(from, to, msg) {
      if (!linked(from, to)) return void dropped++;
      log.push(`${from}>${to} ${msg.id}`);
      queue.push({ from, to, msg: structuredClone(msg) });
    },
    async next() {
      return queue.shift() ?? null;
    },
  };
  return { instance, snapshot: () => ({ log, dropped }) };
});
