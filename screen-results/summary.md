# Model screen on the selfhost tree (2026-11-03)

The 38 regions still pending or stale on main after stage 1 (#43), compiled from the same clean checkout per model:
`compile --keep-going <ids>`, maxAttempts 3, context L0 with expand on failure, llama-server (Vulkan, RX 7600 8 GB,
`-c 16384 --fit on`). Runner: `screen.sh`, ids: `screen-ids.txt`. Logs, final graph and source diff per model.

| model | quant | committed (of 38) | model calls | wall | invalid JSON / repetition loops |
|---|---|---|---|---|---|
| qwen2.5-coder-7b (control) | Q4_K_M | 0 | 75 | 15.4 min | 11 / 8 |
| Seed-Coder-8B-Instruct | Q4_K_M | 10 | 72 | 15.8 min | 3 / 0 |
| Qwen3.5-9B (reasoning off) | Q4_K_M | 10 | 69 | 17.4 min | 2 / 0 |
| Qwen2.5-Coder-14B-Instruct | IQ3_M, KV q8_0, partly on CPU (~8.6 tok/s) | 10 | 57 | 77.7 min | 10 / 8 |

`qwen2.5-coder-14b-iq3m-fetchcap/`: the first 14B run, stopped after 15 calls by fetch's 300 s headers timeout (fixed in #44).

Which regions each verified:
- Seed-Coder-8B: cli.parseArgv, hash.canonicalJson, model.renderTemplate, plan.selectTargets, auth.splitToken, auth.magicLink, lb.leastConnections, p2p.decodeLengthPrefixed, p2p.handshake, p2p.onGossip
- Qwen3.5-9B: sandbox.readHarnessOutput, watch.classifyPath, auth.splitToken, auth.password, auth.magicLink, lb.leastConnections, lb.weighted, p2p.encodeVarint, p2p.handshake, p2p.onGossip
- Qwen2.5-Coder-14B: hash.canonicalJson, plan.selectTargets, sandbox.buildArgv, sandbox.readHarnessOutput, auth.password, lb.leastConnections, p2p.decodeLengthPrefixed, p2p.encodeVarint, p2p.handshake, p2p.onGossip

Union: 16 of 38. The 14B adds one region the 8-9B models missed (sandbox.buildArgv) at 4.5x the wall time.

Reading: the 7B is the wrong model for what is left. Seed-Coder-8B and Qwen3.5-9B tie on count and are complementary
(Seed-Coder + Qwen3.5 cover 15). One run, n=1 seed schedule per model: a screen, not a ranking.
