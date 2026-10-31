# Palette

The palette is OpenArc's library of reusable concepts: high-level building blocks such as authentication, a load balancer or a peer-to-peer protocol, written as **structure** (types, laws, examples, sketches, UI trees) instead of prose prompts. It ships with OpenArc in two forms:

- **Import it:** `import { password } from "open-arc/palette/auth"` gives you the hand-written implementation, which passes every law and example below.
- **Copy it:** the sources are in the package under `palette/` (and in `stage0/src/palette/` in the repository). Put a file in your `src/`, its fakes from `palette/fakes/` in your `tests/fakes/`, and OpenArc compiles, checks and lets you extend it like any of your specs. `examples/palette-demo/` is a project that does exactly that.

Since 0.8.0. The building blocks it uses (sketches, concepts, UI specs) are described in [[Writing Specs]].

## Catalogue

| Concept | File | Variants and regions | Laws (every variant runs them) | Ports and fakes |
|---|---|---|---|---|
| `auth` (interface `Strategy<C>`) | `auth.ts` | `auth.password` (sketch), `auth.apiKey` (prose), `auth.magicLink` (sketch); helper `auth.splitToken` | a valid credential authenticates · a wrong secret is rejected · an unknown user gets the same answer as a wrong secret · a constant-time compare is used · an unknown user still costs one compare | `AuthPorts`: user store, hasher (`hash`, constant-time `equal`), clock. Fake `palette.auth` counts `equal` calls, so a body that compares with `===` fails a law |
| `lbStrategy` (interface `Strategy`) | `loadBalancer.ts` | `lb.roundRobin`, `lb.leastConnections`, `lb.weighted` (smooth weighted round-robin), `lb.consistentHash` (sketch); `lb.hash32`, `lb.healthCheck`, `lb.failover` (sketch) | never route to an unhealthy backend · no healthy backend: every request gets null · no backends at all · an empty batch routes nothing · equal backends share requests evenly (waived by consistent-hash) | `Clock` (`palette.clock`), `Upstream` (`palette.upstream`: `down` backends answer an error, `dead` ones reject) |
| `framing` (interface `Decoder`) | `p2p.ts` | `p2p.decodeLengthPrefixed` (4-byte big-endian), `p2p.decodeVarint` (LEB128); `p2p.encodeLengthPrefixed`, `p2p.encodeVarint`, `p2p.handshake`, `p2p.peerTable`, `p2p.onGossip`, `p2p.broadcast` | whole frames decode in order · a frame split across chunks is reassembled · an incomplete frame is kept as `rest` · an empty message survives · no input, no messages · UTF-8 round trip | `Transport` (`palette.net`: N peers joined by links, FIFO delivery, so multi-peer examples are deterministic) |
| `ui.loginPage` (UI) | `loginPage.spec.tsx`, `loginPage.tsx` | a React login form: email and password fields, an alert for errors, a submit button with a busy state | derived: structure, accessible names, wiring of the form to `props.onLogin`; examples: wrong password, success, a second attempt | `action#onLogin`, `action#onSuccess`; needs `"ui": {"dom": "jsdom"}` |

Variant-specific examples carry the rest: round-robin is fair over N picks, least-connections picks the minimum, consistent-hash moves only the keys a removed node owned, a locked account is reported only after the password matched, an expired magic link says so only when its secret matched, a magic link signs in at most once (the store's `consumeMagicLink` is an atomic compare-and-set, and a request that loses the claim to a concurrent one gets `invalid`), a varint cut in the middle waits for more bytes, the handshake rejects a version mismatch, gossip delivers each message once per peer and stops at its TTL. `stage0/tests/palette.check.ts` also checks the properties on generated inputs (consistent-hash stability over 2,000 keys and five removals, fairness, least-connections over random states, encode/decode round trips under random chunking) and shows that broken bodies fail the laws.

`examples/palette-demo/` uses them: `app.login` (a sketch around `auth.password` that opens a session), `app.serve` (health checks, consistent-hash routing and failover for one request), `app.connect` (two peers negotiate a version) and `app.gossip3` (a 3-peer broadcast over the fake network).

## Writing your own concept

A concept is an interface (a TypeScript type), an intent and laws. A variant is an ordinary region that names the concept and supplies the fixtures the laws mention:

```ts
export type Strategy<C> = (cred: C, ports: AuthPorts) => Promise<AuthResult>;

export const authConcept = arc.defineConcept({
  id: "auth",
  interface: "Strategy",                    // optional: every variant's F must be Strategy<…> (else E020)
  intent: "Authenticate one credential. An unknown user gets the same answer as a wrong secret.",
  laws: [
    { name: "wrong secret is rejected", args: ["$fixture:wrong", "$fixture:ports"], expected: { ok: false, reason: "invalid" } },
    { name: "constant-time compare used", args: ["$fixture:valid", "$fixture:ports"], expected: { ok: true, userId: "u1" },
      fakesAfter: { "palette.auth": { compares: 1 } } },
  ],
});

export const pinSpec = arc.defineRegion<Strategy<{ pin: string }>>({
  id: "auth.pin",
  concept: "auth",
  intent: "A 4-digit PIN.",
  fixtures: { ports: { $fake: "palette.auth", init: { … } }, valid: { pin: "1234" }, wrong: { pin: "0000" } },
  // waive: { "<a law of auth>": "why it can't apply to a PIN" },   only when a law really can't apply to this variant
});
```

- Each law becomes an example of the variant named `law: <name>`, with every `"$fixture:<name>"` replaced by the variant's fixture. Laws are authoritative, like your own examples.
- Make laws about what every variant must do, and give them teeth through fakes: a fake that counts constant-time compares turns "uses a constant-time compare" into an exact expectation.
- A law that can't apply needs a `waive` with a reason; the reason is printed when the variant compiles and stored in the manifest.
- Laws that hold for every variant can be written with literal arguments and no fixtures at all, as the `lbStrategy` laws are.
- Users of a variant see its signature and the concept's one-line summary in their context package, never its body.

## Using sketches

When you know the shape of a function, write it, and leave holes only where you want the model:

```ts
sketch: async (cred, ports) => {
  const email = arc.hole<string>("cred.email trimmed and lower-cased");
  const user = await ports.users.findByEmail(email);
  const stored = user?.passwordHash ?? ports.hasher.dummyHash;
  const match = ports.hasher.equal(await ports.hasher.hash(cred.password, stored), stored);
  if (user === null || !match) {
    arc.hole("if the user exists, record the failure for user.id");
    return { ok: false, reason: "invalid" };
  }
  if (arc.hole<boolean>("the account is locked at ports.clock.now()")) return { ok: false, reason: "locked" };
  return { ok: true, userId: user.id };
},
```

The model writes three short fills; the compiler splices them and checks that nothing else changed (E099). Every hole must be reached by a passing example (W045), and an example that fails before any hole is reported at once (E100), because only you can fix it.

## Using TSX UI specs

```tsx
/** @jsxImportSource open-arc/ui */
ui: (props) => (
  <Form title="Sign in" onSubmit={props.onLogin} onSuccess={props.onSuccess}>
    <Field name="email" type="email" label="Email" required autoComplete="username" />
    <Field name="password" secret label="Password" required autoComplete="current-password" />
    <ErrorText />
    <Submit busyText="Signing in…">Sign in</Submit>
  </Form>
),
```

The component is compiled into the sibling `.tsx` and checked in a real DOM inside the sandbox: the structure and accessible names, the wiring (fill every field, submit, `props.onLogin` gets `{ email, password }`), and your interaction scripts. Add `"ui": { "dom": "jsdom" }` to `openarc.config.json` and install `jsdom`, `react` and `react-dom` as devDependencies.
