# palette-demo

OpenArc's [palette](../../stage0/src/palette/README.md) in use, as a project OpenArc compiles. Every region body is pending: `src/palette/` is the palette's compilable copy (written by `node ../../stage0/tools/palette.ts .`), and `src/app/` uses it:

| Region | What | Form |
|---|---|---|
| `app.login` | a login flow: `auth.password`, then a session or a user-facing message | sketch, 1 hole |
| `app.serve` | a load-balanced service: health checks, consistent-hash routing, failover | sketch, 1 hole |
| `app.connect` | two peers negotiate a protocol version with `p2p.handshake` | prose |
| `app.gossip3` | a 3-peer gossip broadcast over the fake network | sketch, 1 hole |

```bash
npm i                    # open-arc from ../../stage0/build (node tools/build.ts && cd build && npm pack)
npx tsc -p .             # type-checks as scaffolded: sketches, concepts, examples
npx openarc graph        # 23 pending regions; PLAN compiles auth.password before app.login
npx openarc compile      # needs a model (openarc.config.json)
```
