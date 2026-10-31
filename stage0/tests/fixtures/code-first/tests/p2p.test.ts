import * as arc from "open-arc";
import { Peer, type Transport } from "../src/p2p/peer.ts";

arc.test(Peer, "forwards once, with one hop less", async (P, expect, fakes) => {
  const net = fakes.of<Transport>();
  const a = new P("a", ["d", "b", "c"], net);
  expect(await a.receive(null, { id: "g1", origin: "a", ttl: 2, body: "hi" })).toBe(true);
  expect(await a.receive("b", { id: "g1", origin: "a", ttl: 2, body: "hi" })).toBe(false);
  expect(fakes.snapshot(net)).toEqual({ sent: [["a", "b", "g1", 1], ["a", "c", "g1", 1]] });
});

arc.test(Peer, "a last hop is delivered, not forwarded", async (P, expect, fakes) => {
  const net = fakes.of<Transport>();
  const b = new P("b", ["a", "c"], net);
  expect(await b.receive("a", { id: "g2", origin: "a", ttl: 0, body: "yo" })).toBe(true);
  expect(b.delivered).toEqual(["yo"]);
  expect(fakes.snapshot(net)).toEqual({ sent: [] });
});
