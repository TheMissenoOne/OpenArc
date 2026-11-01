# code-first-demo

OpenArc's main way to write a program: ordinary TypeScript. Interfaces and prototype classes are the design, a body that is `return arc.todo();` is where the compiler writes code, JSDoc is the intent, and tests are TypeScript (`arc.test`, `arc.test.hidden`, `arc.law`) that tsc checks against the real classes. Every pending body below is a region; nothing else is generated.

| Region | Declaration | Verified by |
|---|---|---|
| `lb.roundRobin.pick` | `RoundRobin.pick`, a method of a class over a hand-written abstract `Strategy` | 3 tests (1 hidden), a law |
| `lb.leastConnections.pick` | `LeastConnections.pick` | a test, a law |
| `lb.consistentHash.pick` | `ConsistentHash.pick` (calls `hash32`) | a test |
| `lb.hash32` | a top-level function | a test and two JSON examples (`arc.configure`) |
| `p2p.lengthPrefixed.encode` | `LengthPrefixed.encode`, a `Framing` implementation | a test |
| `p2p.lengthPrefixedDecoder.push` | a stateful decoder (`buf`) | a test, a law over random chunk boundaries |
| `p2p.peer.receive` | `Peer.receive`, a gossip peer over a `Transport` port | 2 tests with `fakes.of<Transport>()` (tests/fakes/net.memory.ts) |
| `auth.outcome.toOutcome` | the login page's adapter from an auth result to what the form shows | a same-file test |

```bash
npm i                    # open-arc from ../../stage0/build (node tools/build.ts && cd build && npm pack)
npx tsc -p .             # the pending bodies, the classes and the tests type-check as written
npx openarc graph        # 8 pending regions, with their test counts
npx openarc compile      # needs a model (openarc.config.json); or: npx openarc watch
```

What to look at:

- **Classes.** The class shell (fields, constructor, the other members' signatures) is the model's context and stays yours: the compiler only ever writes between the markers it puts inside a pending body at the first commit. Members of one class are verified together, so a test that calls `markDown` and then `pick` is the normal case.
- **Hidden tests.** `fair over 300 picks` runs in the sandbox on every compile but never appears in the model's context; when it fails, the model is told its name and nothing else.
- **Laws.** `arc.law` runs its body 50 times with a seeded generator (`gen`) and prints the draws of a failing run.
- **Fakes by type.** `fakes.of<Transport>()` is resolved at compile time to the one `defineFake<Transport>` in `tests/fakes/`.
- **The customization layer.** `@arc calls this.net.send` restricts what `Peer.receive` may call; `arc.configure(hash32, { examples })` attaches JSON examples. `defineRegion` with a region's id works as well.

Not here yet (later phases of the code-first design): laws over every implementation of an interface (`arc.implementations<I>()`) and `@arc waive`, in-place sketches with `arc.hole` inside an ordinary body, and the atomic-design UI (`.tsx` molecules and organisms with `arc.render`). The palette's TSX UI specs (`examples/palette-demo`) cover the login page today.
