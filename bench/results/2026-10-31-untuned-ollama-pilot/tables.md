Tasks: 30 from results/2026-10-31-untuned-ollama-pilot. OpenArc 0.6.3. Backends: untuned-ollama.

| backend | model | config | n | held-out tests passed | exercise pass@1 (all held-out pass) | D gated pass@1 | public examples all pass | mean model calls | mean prompt tok | mean output tok | mean wall s | mean wall s excl. load | peak runner RSS MB | successes per 1M tok | held-out tests per 1M tok | mean context chars/attempt |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| untuned-ollama | qwen2.5:7b-instruct-q4_K_M | A | 5 | 0% (0/36) | 0% (0/5) | same | 0% (0/5) | 3.6 | 4224.6 | 1105.8 | 63.2 | 26.7 | 4576 | 0.0 | 0.0 | 3253.8 |
| untuned-ollama | qwen2.5:7b-instruct-q4_K_M | D | 5 | 17% (6/36) | 40% (2/5) | 20% (1/5) | 20% (1/5) | 2.6 | 2405.6 | 634.6 | 13.6 | 13.6 | 1716 | 131.6 | 394.7 | - |
| untuned-ollama | qwen3.5:9b | A | 5 | 0% (0/36) | 0% (0/5) | same | 0% (0/5) | 3.6 | 4307.4 | 982.2 | 95.3 | 30.2 | 1530 | 0.0 | 0.0 | 3253.8 |
| untuned-ollama | qwen3.5:9b | B | 5 | 0% (0/36) | 0% (0/5) | same | 0% (0/5) | 3.6 | 4307.0 | 981.8 | 86.0 | 30.3 | 1640 | 0.0 | 0.0 | 3253.8 |
| untuned-ollama | qwen3.5:9b | C | 5 | 0% (0/36) | 0% (0/5) | same | 0% (0/5) | 3.6 | 8259.2 | 1112.2 | 88.4 | 35.1 | 1787 | 0.0 | 0.0 | 7156.5 |
| untuned-ollama | qwen3.5:9b | D | 5 | 53% (19/36) | 40% (2/5) | 20% (1/5) | 40% (2/5) | 2.2 | 2296.6 | 872.6 | 129.6 | 27.8 | 5414 | 126.2 | 1199.0 | - |

## Per exercise: held-out tests passed (calls, tokens)

| exercise | untuned-ollama|qwen2.5:7b-instruct-q4_K_M|A | untuned-ollama|qwen2.5:7b-instruct-q4_K_M|D | untuned-ollama|qwen3.5:9b|A | untuned-ollama|qwen3.5:9b|B | untuned-ollama|qwen3.5:9b|C | untuned-ollama|qwen3.5:9b|D |
|---|---|---|---|---|---|---|
| acronym | 0/3 (pub fail) (3, 2360) | 3/3 (pub fail) (3, 1929) | 0/3 (pub fail) (3, 2460) | 0/3 (pub fail) (3, 2460) | 0/3 (pub fail) (3, 3923) | 3/3 (pub fail) (3, 2076) |
| flatten-array | 0/3 (pub fail) (3, 2722) | 3/3 (1, 460) | 0/3 (pub fail) (3, 2984) | 0/3 (pub fail) (3, 2984) | 0/3 (pub fail) (3, 4593) | 3/3 (1, 530) |
| food-chain | 0/6 (pub fail) (6, 13528) | 0/6 (pub fail) (3, 6796) | 0/6 (pub fail) (6, 12178) | 0/6 (pub fail) (6, 12178) | 0/6 (pub fail) (6, 24803) | 5/6 (pub fail) (3, 7329) |
| relative-distance | 0/4 (pub fail) (3, 4279) | 0/4 (pub fail) (3, 3180) | 0/4 (pub fail) (3, 4453) | 0/4 (pub fail) (3, 4453) | 0/4 (pub fail) (3, 6919) | 0/4 (pub fail) (3, 4854) |
| wordy | 0/20 (pub fail) (3, 3763) | 0/20 (pub fail) (3, 2836) | 0/20 (pub fail) (3, 4373) | 0/20 (pub fail) (3, 4369) | 0/20 (pub fail) (3, 6619) | 8/20 (1, 1057) |
