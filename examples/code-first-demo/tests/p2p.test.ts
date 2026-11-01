import * as arc from "open-arc";
import { LengthPrefixed, LengthPrefixedDecoder } from "../src/p2p/framing.ts";
import { Peer, type Transport } from "../src/p2p/peer.ts";

arc.test(LengthPrefixed, "a 4-byte big-endian length, then UTF-8", (LP, expect) => {
  expect(new LP().encode("hi")).toEqual([0, 0, 0, 2, 104, 105]);
  expect(new LP().encode("é")).toEqual([0, 0, 0, 2, 195, 169]);
  expect(new LP().encode("")).toEqual([0, 0, 0, 0]);
});

arc.test(LengthPrefixedDecoder, "an incomplete frame stays pending", (D, expect) => {
  const d = new D();
  expect(d.push([0, 0, 0, 2, 104, 105, 0, 0, 0, 5, 116])).toEqual(["hi"]);
  expect(d.pending()).toEqual([0, 0, 0, 5, 116]);
  expect(d.push([0, 0])).toEqual([]);
});

// A stateful decoder driven across many pushes: one law over random chunk boundaries (it uses encode too, so it
// verifies the decoder once LengthPrefixed.encode is compiled; PLAN compiles it first, in source order).
arc.law(LengthPrefixedDecoder, "any chunking decodes every message, in order", (D, expect, gen) => {
  const f = new LengthPrefixed();
  const messages = gen.array((g) => g.string({ alphabet: "ab é∑", max: 40 }), { max: 4 });
  const bytes = messages.flatMap((m) => f.encode(m));
  const d = new D();
  const out: string[] = [];
  for (let i = 0; i < bytes.length; ) {
    const n = gen.int(1, 7);
    out.push(...d.push(bytes.slice(i, i + n)));
    i += n;
  }
  expect(out).toEqual(messages);
  expect(d.pending()).toHaveLength(0);
});

arc.test(Peer, "forwards once, with one hop less", async (P, expect, fakes) => {
  const net = fakes.of<Transport>();
  const a = new P("a", ["d", "b", "c"], net);
  expect(await a.receive(null, { id: "g1", origin: "a", ttl: 2, body: "hi" })).toBe(true);
  expect(a.delivered).toEqual(["hi"]);
  expect(await a.receive("b", { id: "g1", origin: "a", ttl: 2, body: "hi" })).toBe(false);
  expect(a.delivered).toEqual(["hi"]);
  expect(fakes.snapshot(net)).toEqual({ sent: [["a", "b", "g1", 1, "hi"], ["a", "c", "g1", 1, "hi"]] });
});

arc.test(Peer, "a last hop is delivered, not forwarded", async (P, expect, fakes) => {
  const net = fakes.of<Transport>();
  const b = new P("b", ["a", "c"], net);
  expect(await b.receive("a", { id: "g2", origin: "a", ttl: 0, body: "yo" })).toBe(true);
  expect(b.delivered).toEqual(["yo"]);
  expect(fakes.snapshot(net)).toEqual({ sent: [] });
});
