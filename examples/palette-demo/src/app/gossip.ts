// A 3-peer network on top of the p2p palette: two peers negotiate a protocol version, then a message is gossiped to
// everyone. The fake network (tests/fakes/palette.net.ts) makes the multi-peer runs deterministic.
import * as arc from "open-arc";
import * as p2p from "../palette/p2p.ts";

type Connect = (versionsA: number[], versionsB: number[]) => { a: p2p.HsState; b: p2p.HsState; messages: number };

export const connectSpec = arc.defineRegion<Connect>({
  id: "app.connect",
  intent: [
    "Run p2p.handshake between peer a (versionsA) and peer b (versionsB) to the end. Both start idle; a gets {type: 'start'}.",
    "Then deliver every sent message to the other side, oldest first, as an event of the same shape, until nothing is left. messages counts the deliveries.",
  ],
  examples: [
    { name: "they agree on 2", args: [[1, 2], [2, 3]], expected: { a: { phase: "ready", version: 2, error: null }, b: { phase: "ready", version: 2, error: null }, messages: 2 } },
    { name: "a version mismatch fails both sides", args: [[1], [2]], expected: { a: { phase: "failed", version: null, error: "version-mismatch" }, b: { phase: "failed", version: null, error: "version-mismatch" }, messages: 2 } },
    { name: "no versions at all", args: [[], [1]], expected: { a: { phase: "failed", version: null, error: "version-mismatch" }, b: { phase: "failed", version: null, error: "version-mismatch" }, messages: 2 } },
  ],
});

// @openarc:begin app.connect
export const connect: Connect = (versionsA, versionsB) => arc.todo("app.connect");
// @openarc:end app.connect

type Gossip3 = (net: p2p.Transport, body: string) => Promise<p2p.BroadcastResult>;

export const gossip3Spec = arc.defineRegion<Gossip3>({
  id: "app.gossip3",
  examples: [
    {
      name: "fully connected: everyone delivers once",
      args: [{ $fake: "palette.net", init: { links: [["a", "b"], ["b", "c"], ["a", "c"]] } }, "hello"],
      expected: { delivered: { a: ["hello"], b: ["hello"], c: ["hello"] }, sent: 4 },
      fakesAfter: { "palette.net": { log: ["a>c demo-1", "a>b demo-1", "c>b demo-1", "b>c demo-1"], dropped: 0 } },
    },
    {
      name: "a line still reaches c in two hops",
      args: [{ $fake: "palette.net", init: { links: [["a", "b"], ["b", "c"]] } }, "hi"],
      expected: { delivered: { a: ["hi"], b: ["hi"], c: ["hi"] }, sent: 3 },
      fakesAfter: { "palette.net": { log: ["a>b demo-1", "b>c demo-1"], dropped: 1 } },
    },
    {
      name: "no links: only a has it",
      args: [{ $fake: "palette.net", init: { links: [] } }, ""],
      expected: { delivered: { a: [""], b: [], c: [] }, sent: 2 },
    },
  ],
  sketch: async (net, body) => {
    const ids = ["a", "b", "c"];
    const peers = ids.map((self) => ({ self, peers: ids.filter((x) => x !== self).reduce((t, peer) => p2p.peerTable(t, { type: "connected", peer }, 8), [] as string[]), seen: [] as string[] }));
    return p2p.broadcast(net, peers, "a", arc.hole<p2p.Gossip>("message id 'demo-1' from origin 'a', ttl 2, carrying body"), 2);
  },
});

// @openarc:begin app.gossip3
export const gossip3: Gossip3 = (net, body) => arc.todo("app.gossip3");
// @openarc:end app.gossip3
