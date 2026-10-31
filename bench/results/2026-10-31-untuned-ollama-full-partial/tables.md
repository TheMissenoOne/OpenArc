Tasks: 4 from results/2026-10-31-untuned-ollama-full-partial. OpenArc 0.6.4. Backends: untuned-ollama.

| backend | model | config | n | held-out tests passed | exercise pass@1 (all held-out pass) | D gated pass@1 | public examples all pass | mean model calls | mean prompt tok | mean output tok | mean wall s | mean wall s excl. load | peak runner RSS MB | successes per 1M tok | held-out tests per 1M tok | mean context chars/attempt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| untuned-ollama | qwen3.5:9b | A | 1 | 0% (0/3) | 0% (0/1) | same | 0% (0/1) | 3.0 | 2210.0 | 250.0 | 176.1 | 22.7 | 1247 | 0.0 | 0.0 | 2260.0 |
| untuned-ollama | qwen3.5:9b | B | 1 | 0% (0/3) | 0% (0/1) | same | 0% (0/1) | 3.0 | 2210.0 | 250.0 | 239.2 | 11.3 | 1252 | 0.0 | 0.0 | 2260.0 |
| untuned-ollama | qwen3.5:9b | C | 1 | 0% (0/3) | 0% (0/1) | same | 0% (0/1) | 3.0 | 3520.0 | 403.0 | 292.8 | 24.6 | 1251 | 0.0 | 0.0 | 3760.0 |
| untuned-ollama | qwen3.5:9b | D | 1 | 100% (3/3) | 100% (1/1) | 0% (0/1) | 0% (0/1) | 3.0 | 1554.0 | 522.0 | 14.6 | 14.6 | 1496 | 481.7 | 1445.1 | - |

## Per exercise: held-out tests passed (calls, tokens)

| exercise | untuned-ollama|qwen3.5:9b|A | untuned-ollama|qwen3.5:9b|B | untuned-ollama|qwen3.5:9b|C | untuned-ollama|qwen3.5:9b|D |
|---|---|---|---|---|
| acronym | 0/3 (pub fail) (3, 2460) | 0/3 (pub fail) (3, 2460) | 0/3 (pub fail) (3, 3923) | 3/3 (pub fail) (3, 2076) |
