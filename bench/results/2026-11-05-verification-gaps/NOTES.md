# Would `--mutants` or `--oracle` have caught the known gaps?

CodeRabbit found 7 gaps in frozen self-host bodies that pass all their examples (`docs/wiki/Bootstrap.md`, freeze section). This asks whether OpenArc's own checks would have found them. No model calls. The oracle reference is stage 0's hand-written body, a reference most projects don't have.

| Gap | `--mutants` | `--oracle`, default 60 inputs | `--oracle --runs 1000` |
|---|---|---|---|
| `parseOutput`: no `body` accepted | no | **yes** (misspelled keys, never `{}` itself) | yes |
| `parseOutput`: bad import items accepted | no | no | no (none at 5,000 either) |
| `parseOutput`: `imports` checked before unexpected properties | no | no | no (none at 5,000 either) |
| `broadcast`: unknown peer throws | no | can't run | can't run |
| `broadcast`: `__proto__` peer | no | can't run | can't run |
| `onGossip`: candidates not sorted | no | no | **yes** (19 inputs) |
| `onGossip`: negative `fanout` forwards | no | no | weak (1 of 219 negative inputs disagreed, possibly for another reason) |

**Totals:** mutants 0 of 7; oracle 1 of 7 by default, and 2 to 3 of 7 at 1,000 runs.

## Why
- **Mutants measure the examples, not the body.** They change a body and ask whether the examples notice. A behaviour no example mentions is invisible, so `parseOutput` and `broadcast` score 100% with these bugs in them. `onGossip`'s one survivor (`ttl <= 1`) is unrelated to its gaps.
- **The oracle only explores near the examples.** It varies strings and numbers from the example arguments. A JSON string's characters change, but not its structure, so `{}` and non-string `names` are never generated.
- **The oracle can't run on `broadcast`,** because one of its arguments is a fake port rather than plain data.
- **Without a reference, the oracle doesn't run at all.** That's the normal case, so for most projects the total here is 0 of 7.

## What this means
A verified region means its examples pass, and nothing in the toolchain closes that gap on its own. Three cheap things could help, none tried yet:
1. **Second-opinion bodies:** generate a second body and use it as the oracle reference, with disagreements flagged for a person. This needs no hand-written reference.
2. **Structural variation for JSON inputs:** delete keys, change value types, and empty the object.
3. **Examples drawn from the intent:** ask a model to turn each sentence of the intent into an example before compiling.
