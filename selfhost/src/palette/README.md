# OpenArc palette

Reusable concepts that ship with OpenArc: high-level building blocks written as specs (types, laws, examples, sketches) instead of prose prompts. Each file is an ordinary OpenArc source file. In `stage0/src/palette/` every body is hand-written and passes its laws and examples; in `selfhost/src/palette/` and `examples/palette-demo/src/palette/` the bodies are pending, for OpenArc to compile.

| File | Concept and regions | Ports and fakes |
|---|---|---|
| `auth.ts` | concept `auth` (interface `Strategy<C>`): `auth.password` (sketch), `auth.apiKey` (prose), `auth.magicLink` (sketch); helper `auth.splitToken` | `AuthPorts` = user store, hasher with a constant-time `equal`, clock. Fake `palette.auth` |
| `loadBalancer.ts` | concept `lbStrategy` (interface `Strategy`): `lb.roundRobin`, `lb.leastConnections`, `lb.weighted`, `lb.consistentHash` (sketch); `lb.hash32`, `lb.healthCheck`, `lb.failover` (sketch) | `Clock`, `Upstream`. Fakes `palette.clock`, `palette.upstream` |
| `p2p.ts` | concept `framing` (interface `Decoder`): `p2p.decodeLengthPrefixed`, `p2p.decodeVarint`; `p2p.encodeLengthPrefixed`, `p2p.encodeVarint`, `p2p.handshake`, `p2p.peerTable`, `p2p.onGossip`, `p2p.broadcast` | `Transport`. Fake `palette.net`: an in-memory network that links N peers and delivers in FIFO order |

## Laws

A concept's laws are example templates; every variant runs them with its own `fixtures`, as authoritative examples named `law: …`.

- **auth:** a valid credential authenticates; a wrong secret is rejected; an unknown user gets the same answer as a wrong secret; every attempt runs exactly one constant-time compare, also for an unknown user (the fake counts `hasher.equal` calls, so a body that compares with `===` fails).
- **lbStrategy:** never route to an unhealthy backend; with no healthy backend every request gets `null`; an empty batch routes nothing; equal backends share requests evenly (waived by `lb.consistentHash`, whose spread is statistical). Variant examples add: round-robin is fair over N picks, least-connections picks the minimum, and consistent-hash moves only the keys a removed node owned.
- **framing:** whole frames decode in order; a frame split across chunks (prefix included) is reassembled; an incomplete frame is kept as `rest`; an empty message survives; UTF-8 round-trips.

`stage0/tests/palette.check.ts` also checks these properties on generated inputs (consistent-hash stability over 2,000 keys, fairness, encode/decode round trips with random chunking) and shows that broken bodies fail the laws.

## Using it

Import the hand-written implementation:

```ts
import { password, type AuthPorts } from "open-arc/palette/auth";
const r = await password({ email, password: pw }, ports);
```

Or copy a file into your project to compile, change or extend it: `src/palette/<file>.ts` goes to your `src/`, and `tests/fakes/palette.*.ts` to your `tests/fakes/` (fix the one `import type` path at the top of each fake). From a checkout of the OpenArc repository (the published package has no `tools/`), `node stage0/tools/palette.ts <dir>` writes the copy with pending bodies; it refuses to overwrite existing palette files unless you pass `--force`. Add a variant by writing a region with `concept: "<id>"` and the fixtures the laws name; the laws come with it.

## Writing your own concept

```ts
export type Strategy<C> = (cred: C, ports: AuthPorts) => Promise<AuthResult>;
export const authConcept = arc.defineConcept({
  id: "auth",
  interface: "Strategy",          // optional: every variant's F must be Strategy<…>
  intent: "…",
  laws: [{ name: "wrong secret is rejected", args: ["$fixture:wrong", "$fixture:ports"], expected: { ok: false, reason: "invalid" } }],
});
export const pinSpec = arc.defineRegion<Strategy<{ pin: string }>>({
  id: "auth.pin", concept: "auth",
  fixtures: { wrong: { pin: "0000" }, ports: { $fake: "palette.auth", init: { … } } },
  // waive: { "<a law of auth>": "why it can't apply here" },   only when a law really can't apply to this variant
});
```

See the wiki page [Palette](https://github.com/TheMissenoOne/OpenArc/blob/main/docs/wiki/Palette.md).
