# Local LLM setup for OpenArc on this machine

Measured on 2026-10-31. Everything below was measured on this machine, not taken from other people's benchmarks.

## Summary

- **Recommended stack:** llama.cpp `llama-server` with the **Vulkan** backend (built from source, tag b12023), serving one GGUF model on `127.0.0.1:8080`. OpenArc talks to it through the `local` preset. **Model: qwen2.5-coder 7B Instruct Q4_K_M with `outputFormat: "json"`**, chosen by a quality screen on OpenArc tasks (see [Model choice](#model-choice)). With the recommended flags it does an OpenArc request in 7.5 s (TTFT 1.7 s, 54 tok/s, 10/10 valid JSON, 6.1 GiB VRAM, 0.4 GiB RSS).
- **Why Vulkan llama-server over the current Ollama (ROCm):** about 10% faster generation (43.0 vs 39.2 tok/s on qwen3.5 9B), 1.4 GB less VRAM (6.2 vs 7.5 GiB; Ollama also loads the vision projector), lower and flat RAM, 10/10 valid JSON, and no `HSA_OVERRIDE_GFX_VERSION` hack. Ollama ROCm wins only on prompt processing (about 10% faster TTFT), which matters less than generation for OpenArc's 1,700-token-in / 400-token-out requests.
- **The biggest bottleneck isn't the inference engine. It's the disk.** `/mnt/data` is a SAMSUNG HD250HJ, a 250 GB **spinning disk**. Loading a 5.6 GB model from it cold takes 113-145 s; from the page cache, 15-40 s. Avoid model swaps: keep one model and a long idle timeout. If you can, put the active GGUF on the NVMe (see "Things that need sudo or a decision").
- **Model:** of 7 candidates screened on ts-bench exercises through OpenArc, qwen2.5-coder 7B passed the most held-out tests in OpenArc's contract-only mode (40%) and was also the fastest (10 s/task). Bigger models did not do better: a 14B, Gemma 4 12B, Qwen3-Coder-30B-A3B (MoE, partial offload) and the current qwen3.5 9B all scored 23-37% there. Fallback: Seed-Coder 8B.
- **Memory traps found:** llama-server keeps an **8 GiB host-RAM prompt cache by default** (`--cache-ram 8192`). RSS grew 0.18 GiB per request in testing, which on 15 GB RAM would recreate the earlier OOM. The recommended config sets `--cache-ram 0`; RSS then stays flat at 0.82 GiB.

## Machine (verified)

| | |
|---|---|
| OS | Fedora 43, kernel 7.2.13, no sudo (`sudo -n` asks for a password) |
| CPU / RAM | 16 threads, 15 GiB RAM, 8 GiB swap |
| GPU | AMD Radeon RX 7600 (Navi 33, gfx1102), 8176 MiB VRAM; the desktop uses about 0.75 GiB of it |
| Disks | `/` NVMe, 4.7 GB free. `/mnt/data` **HDD** (rotational=1, SAMSUNG HD250HJ) |
| ROCm SDK | none on the host (`/opt/rocm` absent, no `hipcc`). Ollama bundles ROCm 7.2 runtime libs |
| Vulkan | loader 1.4.341 and Mesa RADV 25.3.6 installed; no headers, no `glslc`, no `vulkaninfo` |
| Toolchain | gcc 15.3, cmake 3.31, podman (rootless), uv, Python 3.14, node 25 |
| Ollama | 0.40.5, user service, ROCm with `HSA_OVERRIDE_GFX_VERSION=11.0.0` (the card shows up as gfx1100), bundled llama.cpp ggml 0.27 |

## How things were built (no sudo)

Downloaded prebuilt binaries were not used. Running downloaded executables is blocked here, and the user asked for source builds anyway. The host lacks Vulkan headers, `glslc` and a HIP SDK, so a throwaway **rootless podman container (Fedora 43 + distro packages)** provided the toolchain:

- `/mnt/data/tools/llm-setup/Containerfile.build`: gcc, cmake, ninja, vulkan-headers, glslc, rocm-hip-devel, hipblas/rocblas-devel.
- `/mnt/data/tools/llm-setup/build-llama.sh vulkan|hip`: builds with `-DGGML_VULKAN=ON` or `-DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1102`, static, inside the container with `--memory 4g`.
- Results: the **Vulkan** build (`/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server`, 2 min 20 s) is a static binary that runs **directly on the host**, needing only the host's libvulkan and RADV. The **HIP** build (9 min 44 s) links Fedora's ROCm 6.x libs and so only runs inside the container. It detects the card natively as gfx1102, with no override needed.
- After measuring, the container image (8.7 GB), the HIP build and the build tree were deleted because Vulkan won; only `build-vulkan/bin/{llama-server,llama-bench,llama-cli}` and the source checkout (`src`, tag b12023) remain. To rebuild either: `podman --root /mnt/data/tools/containers/storage build -t llama-build -f Containerfile.build .` with `TMPDIR=/mnt/data/tools/containers/tmp` (a commit with the default TMPDIR fills `/`), then `build-llama.sh`.

## Results

All numbers are medians of 3 timed runs after a warm-up, temperature 0, one request at a time, full GPU offload (`-ngl 99`), flash attention on unless noted. The OpenArc-shaped request (`bench_openarc.py`) is a real OpenArc context package (about 1,690 prompt tokens), asking for the `model.parseOutput` body, with OpenArc's `{body, imports}` JSON schema as `response_format` / Ollama `format`. It is streamed so TTFT is real, and each prompt starts with a unique nonce so no prefix cache is reused. JSON validity is over 11 runs (the warm-up plus 10) with a 1,024-token cap.

### llama-bench (pp512 / tg128, tokens/s)

| model | backend | FA off | FA on | FA on + q8_0 KV | FA on, at 4k depth |
|---|---|---|---|---|---|
| qwen3.5 9B Q4_K_M | Vulkan | 955 / 43.8 | **994 / 43.8** | 964 / 43.6 | 842 / 42.3 (q8: 851 / 42.3) |
| qwen3.5 9B Q4_K_M | HIP (ROCm 6.x, native gfx1102) | 1151 / 41.2 | **1236 / 41.5** | 1157 / 40.3 | n/m |
| qwen2.5-coder 7B Q4_K_M | Vulkan | 1008 / 55.1 | **1073 / 55.7** | 1040 / 54.7 | n/m |
| qwen2.5-coder 7B Q4_K_M | HIP | 1223 / 52.2 | **1334 / 54.2** | 1315 / 52.7 | n/m |
| qwen2.5-coder 14B IQ3_M | Vulkan | n/m | n/m | **522 / 35.5** (full offload, 7.35 GiB VRAM) | n/m |
| qwen2.5-coder 14B IQ3_M | HIP | n/m | n/m | **654 / 32.0** | n/m |

HIP is 15-25% faster at prompt processing; Vulkan is 2-10% faster at generation. Flash attention helps both. q8_0 KV costs 1-3% speed. For qwen3.5 it saves almost nothing, because the model is hybrid with only 8 attention layers (an 8k f16 KV cache is about 256 MiB). For a dense 14B it is what makes full offload fit.

### OpenArc-shaped request (qwen3.5 9B Q4_K_M, about 1,690 tokens in, JSON schema out)

| stack | TTFT s | total s | prompt tok/s | gen tok/s | out tokens | valid JSON | peak VRAM GiB | peak RSS GiB | ready / cold load |
|---|---|---|---|---|---|---|---|---|---|
| Ollama 0.40.5 ROCm, as configured today (FA auto, f16 KV) | 1.85 | 12.38 | 983 | 39.2 | 413 | 10/10 | 7.54 | about 2.0 (runner, read directly) | 145 s (HDD, disk busy) |
| Ollama 0.40.5 ROCm + `FLASH_ATTENTION=1`, `KV_CACHE_TYPE=q8_0` | 1.79 | 13.04 | 1014 | 38.9 | 435 | 9/11 (2 hit the cap) | 7.30 | 2.99 | 20.7 s (page cache) |
| Ollama 0.40.5 **Vulkan** (`OLLAMA_VULKAN=1`) + FA + q8_0 | 2.00 | 23.13* | 902 | 41.8 | 882* | 10/11 (1 hit the cap) | 6.88 | 2.79 | 37.6 s (page cache) |
| llama-server HIP (container), q8_0 KV, `--cache-ram 0` | 1.63 | 11.33 | 1042 | 39.9 | 384 | 11/11 | 6.18 | 2.37 (flat) | 116 s (ROCm libs from HDD) |
| llama-server Vulkan, q8_0 KV, default cache-ram | 2.03 | 10.81 | 881 | 43.0 | 378 | 11/11 | 5.77 | 2.09 (**grows** 0.18/request) | **113 s (true cold HDD read)** |
| **llama-server Vulkan, recommended flags** (`-c 16384`, f16 KV, `--cache-ram 0`, `--reasoning off`) | **1.86** | **10.69** | 911 | **43.0** | 378 | **11/11** | 6.17 | **0.82 (flat)** | 15.7 s (page cache) |
| **llama-server Vulkan, recommended flags, qwen2.5-coder 7B Q4_K_M** (same request, 1,579 tokens with its tokenizer) | **1.69** | **7.49** | 971 | **54.3** | 319 | **11/11** | 6.08 | **0.40 (flat)** | 64 s (partly cached) |

\* That run's model output was about 880 tokens in half the runs: the model sometimes copies spec examples from the context. That is model behaviour that varies run to run, not engine speed; compare generation tok/s. All "invalid" outputs were truncations at the 1,024-token test cap (runaway output), not schema violations. The schema-constrained grammar never produced schema-invalid JSON on either engine. OpenArc's real cap is 3,072-4,096 and it retries truncations with double the cap.

Notes:
- Ollama's newer releases (0.40.6-0.40.13, through 2026-10-28) only add models (LFM3, Flint, d3, speech) and fix the Responses API. Nothing touches AMD, ROCm/Vulkan, or structured output, so a side-by-side test of 0.40.13 was not worth 2.5 GB. Its bundled engine is the same llama.cpp `llama-server`.
- Ollama runs qwen3.5 9B with its vision projector (`--mmproj`) loaded. That is part of why it uses 1.4 GiB more VRAM.
- Cold load is dominated by the HDD (about 50 MB/s effective): 5.6 GB in 113 s. The same server start with the file in the page cache took 15.7 s.

## Recommended stack and settings

```
/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server \
  -m /mnt/data/models/gguf/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf -a qwen2.5-coder-7b --host 127.0.0.1 --port 8080 \
  -ngl 99 -c 16384 -fa on -np 1 --cache-ram 0 --sleep-idle-seconds 900 --jinja --reasoning off --no-webui
```

| flag | why |
|---|---|
| `-ngl 99` | full offload; 6.1 GiB VRAM at 16k context (measured, qwen2.5-coder 7B; qwen3.5 9B: 6.2) |
| `-c 16384` | twice the context OpenArc used before, still about 1.3 GiB VRAM headroom |
| `-fa on` | +4% prompt speed on Vulkan |
| f16 KV (default) | fits at 16k for the 7-9B models; q8_0 costs 1-3% speed. Use `-ctk q8_0 -ctv q8_0` for 12-14B models or contexts above 16k |
| `-np 1` | OpenArc sends one request at a time; one slot means no KV split |
| `--cache-ram 0` | **memory safety**: the default 8 GiB host prompt cache grows per request |
| `--sleep-idle-seconds 900` | unloads weights and KV after 15 min idle (llama-server's keep_alive); the next request reloads (15-40 s cached, about 2 min from a cold HDD) |
| `--reasoning off` | turns thinking off server-side for reasoning models (qwen3.5); OpenArc's `local`/`openai` provider sends no thinking switch. Harmless for qwen2.5-coder |
| models in `/mnt/data/models/gguf/` | `Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf` (recommended), `Seed-Coder-8B-Instruct-Q4_K_M.gguf` (fallback), `Qwen3.5-9B-Q4_K_M.gguf` (a **hard link** to Ollama's qwen3.5:9b blob: no extra disk). `MODEL_KEY=<name> apply.sh` switches |

### Memory-safety settings (the OOM earlier today was two models resident)

1. Only one big model resident at a time. llama-server serves exactly one model and sleeps after 15 min idle. Ollama gets `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_KEEP_ALIVE=10m` (drop-in written by `apply.sh`).
2. **Don't use Ollama and llama-server models at the same time.** Both fit alone (6.2 + 7.5 GiB > 8 GiB), so the second would spill into system RAM. If you need Ollama for another model, run `curl -s localhost:8080/props` and wait for `is_sleeping: true`, or `systemctl --user stop llama-server`.
3. `--cache-ram 0` (see above).
4. The systemd unit has `MemoryHigh=3G`, `MemoryMax=4G`, so a runaway llama-server is throttled and then killed instead of taking the desktop down. Measured steady RSS is 0.8-1.2 GiB.
5. Builds ran with `nice -n 19`, `-j4/-j6` and a 4 GiB container memory cap.

### How to switch

1. Read and run `/mnt/data/tools/llm-setup/apply.sh` when no OpenArc job is running. It:
   - creates the model hard link if missing;
   - writes `~/.config/systemd/user/llama-server.service` with the flags above and starts it on 127.0.0.1:8080;
   - adds the drop-in `~/.config/systemd/user/ollama.service.d/openarc-tuning.conf` (one model, one request, FA, keep-alive 10m) and restarts `ollama.service` **only if it holds no model**, otherwise it prints the command;
   - waits for `/health` and runs a JSON-schema smoke test.
2. Point OpenArc at it (next section). Undo with `apply.sh --revert`.

## OpenArc config

Recommended: the `local` preset (OpenArc 0.7.x; an OpenAI-compatible server with no key) pointed at llama-server. `keepAlive` doesn't apply to this provider; the server's `--sleep-idle-seconds 900` plays that role. On OpenArc 0.6.x, write `"provider": "openai"` with the same `baseUrl` instead.

```json
{
  "version": 1,
  "backends": {
    "local": {
      "provider": "local",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "model": "qwen2.5-coder-7b",
      "maxContextTokens": 16384,
      "outputFormat": "json",
      "outputReserveTokens": 4096
    }
  },
  "compilation": { "defaultBackend": "local", "maxAttempts": 3, "context": { "initialLevel": 0, "expandOnFailure": true } }
}
```

- No `apiKeyEnv`: llama-server needs none. OpenArc only requires a key for `api.openai.com` (checked in open-arc 0.7.1 `config.js`).
- `maxContextTokens: 16384` matches the server's `-c 16384`. Keep them equal: a bigger budget than `-c` makes llama-server reject long prompts.
- `structuredOutput` stays the default `json_schema`; llama-server converts it to a grammar (11/11 valid).

If you stay on Ollama, the tuned equivalent is:

```json
"local": { "provider": "ollama", "model": "qwen3.5:9b", "maxContextTokens": 8192, "think": false, "keepAlive": "10m" }
```

## Model choice

The question "which model is best here" is decided by correctness on OpenArc-style tasks, not speed alone. Each candidate ran a quality screen through **this** server setup (llama-server Vulkan, one model at a time, server stopped between models). It used the existing harness (`openarc-wt-bench/bench/run.mjs`) against open-arc 0.7.1, on 8 ts-bench function exercises: acronym, binary-search, flatten-array, food-chain, relative-distance, spiral-matrix, transpose, wordy. That is 57 **held-out** tests the model never sees. The arms were OpenArc config **A** (contract only) with `outputFormat: "json"` and `"code"`, and the plain-prompt baseline **D**. Settings: temperature 0, seed 1, context 8192, output cap 4096, 3 attempts. Raw results are in `openarc-wt-bench/bench/results/2026-10-31-model-screen/{json,code}/tasks.jsonl` and `servers.jsonl`, and the table comes from `/mnt/data/tools/llm-setup/screen/rank.py`.

### Candidates (fit-checked for 8 GiB VRAM and 15 GiB RAM)

| model | quant, size | placement | why it was in |
|---|---|---|---|
| qwen2.5-coder 7B Instruct | Q4_K_M, 4.7 GB | full GPU | strong small coder |
| Seed-Coder 8B Instruct (ByteDance) | Q4_K_M, 5.1 GB | full GPU | newer small coder |
| qwen3.5 9B (current default) | Q4_K_M, 5.6 GB | full GPU | the newest Qwen dense model that fits |
| Granite 4.2 8B (IBM) | Q4_K_M, 5.3 GB | full GPU | recent 8B, structured output focus |
| qwen2.5-coder 14B Instruct | IQ3_M, 6.9 GB | full GPU with q8_0 KV (7.3 GiB) | the biggest dense coder that fully offloads |
| Gemma 4 12B it (QAT) | q4_0, 7.0 GB | **partial** offload (`--fit`), q8_0 KV | strong recent 12B |
| Qwen3-Coder-30B-A3B Instruct (MoE, 3B active) | UD-IQ2_M, 10.8 GB | experts partly in RAM (`--fit`), q8_0 KV | the largest coder that fits in VRAM plus RAM |

Ruled out without running: qwen3.5/3.6 35B-A3B and Qwen3.8 27B (16-22 GB even at Q3/Q4, and dense 27B would mostly run on the CPU); Flint 40B-A2.5B (23 GB); deepseek-coder-v2-lite, codegemma, phi (2024-era, superseded by the above). Ollama has no qwen3.5/3.6 coder below 27B.

### Ranked results (quality first: held-out pass rate, then exercises fully passed, then speed)

| # | model | arm | held-out passed | exercises all-pass (pass@1) | invalid JSON attempts / calls | gen tok/s | s / task | successes / min | VRAM GiB | runner RSS GiB |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **qwen2.5-coder 7B** | **A json** | **23/57 (40%)** | 2/8 | 0/17 | 45.8 | **10** | **1.51** | 5.63 | 0.39 |
| 2 | Seed-Coder 8B | A json | 21/57 (37%) | 2/8 | 0/19 | 43.5 | 18 | 0.83 | 6.50 | 0.38 |
| 3 | qwen2.5-coder 14B IQ3_M | A json / code | 21/57 (37%) | 2/8 | 0/19 | 21.6 | 21-33 | 0.45-0.71 | 7.28 | 0.48 |
| 4 | Gemma 4 12B | A json | 21/57 (37%) | 2/8 | 0/17 | 10.8 | 122 | 0.12 | 6.96 | 3.12 |
| 5 | qwen3.5 9B | A json / code | 16/57 (28%) | 2/8 | 0/20 | 36.5 | 18-20 | 0.74-0.81 | 6.12 | 1.17 |
| 6 | Qwen3-Coder-30B-A3B IQ2_M | A code (json: 13/57) | 16/57 (28%) | 2/8 | 0/21 | 20-26 | 33-37 | 0.20-0.46 | 7.01 | 9.0 (mmap'd experts) |
| 7 | Granite 4.2 8B | A code (json: 7/57) | 14/57 (25%) | 0/8 | 0/23 | 39.4 | 30-34 | 0.00 | 7.14 | 0.36 |

The baseline D (whole-file prompt, the same models) for reference: Qwen3-Coder-30B-A3B 33/57 (58%, 1.33 successes/min); Gemma 4 12B 32/57 (56%, 0.29/min, one task died at Node's 300 s fetch timeout); Seed-Coder 8B 29/57 (51%, 2.08/min); qwen2.5-coder 7B 27/57 (47%, 3.03/min); 14B and qwen3.5 24/57; Granite 14/57.

`outputFormat`: **json** won or tied for 5 of 7 models (qwen2.5-coder 7B: json 40% vs code 23%; Seed-Coder: 37% vs 28%; qwen3.5 and 14B tied). Only the MoE and Granite did better with code. Structured JSON was never the failure mode: **0 schema-invalid attempts in 136 json-mode calls** across all models, because llama-server enforces the schema as a grammar.

### Decision

- **Best model for OpenArc on this machine: qwen2.5-coder 7B Instruct Q4_K_M, `outputFormat: "json"`.** It has the highest held-out pass rate in OpenArc mode and is also the fastest (54 tok/s, 7.5 s per OpenArc-shaped request, 10 s per task), with the smallest VRAM (5.6-6.1 GiB) and RAM (0.4 GiB) use. It is also the best speed/quality trade-off, by a wide margin in successes per minute (1.51 vs 0.83 for the next).
- **Fallback: Seed-Coder 8B Instruct Q4_K_M** (`MODEL_KEY=seed-coder-8b ./apply.sh`). Second on quality and close to it, 37% vs 40%, with a different training lineage. If a region fails repeatedly with the 7B, it is the one to try. qwen3.5 9B stays available (the hard link costs nothing) but scored lowest of the full-offload Qwen models in OpenArc mode.
- **Bigger is not better here.** The 14B (IQ3) and Gemma 4 12B tie Seed-Coder in OpenArc mode at 2-12x the time per task. The 30B MoE at IQ2 only shines in the whole-file baseline, and it needs about 9 GiB of mmap'd experts in RAM: one page-cache eviction re-reads them from the HDD. Don't use it as a daily driver on 15 GiB RAM.
- Caveat: 8 exercises and 57 tests is a **screen**, not a benchmark. A difference of 2-3 tests (for example 23 vs 21) is within noise. The ranking of "7B coder at least as good as 12-30B models, and 2-10x faster" is robust; the 7B-vs-Seed-Coder order is not.

### Exact server flags per model

| model | flags (plus `-m <gguf> -a <name> --host 127.0.0.1 --port 8080 -np 1 --cache-ram 0 --sleep-idle-seconds 900 --jinja --reasoning off --no-webui`) |
|---|---|
| qwen2.5-coder 7B Q4_K_M (recommended) | `-ngl 99 -c 16384 -fa on` (f16 KV; 6.1 GiB VRAM) |
| Seed-Coder 8B Q4_K_M (fallback) | `-ngl 99 -c 16384 -fa on` (6.5 GiB at 8k; add `-ctk q8_0 -ctv q8_0` above 16k) |
| qwen3.5 9B Q4_K_M | `-ngl 99 -c 16384 -fa on` (6.2 GiB) |
| qwen2.5-coder 14B IQ3_M | `-ngl 99 -c 8192 -fa on -ctk q8_0 -ctv q8_0` (7.3 GiB, no headroom) |
| Gemma 4 12B q4_0 | `-ngl auto -c 8192 -fa on -ctk q8_0 -ctv q8_0` (with `-ngl 99` it overcommits VRAM and RADV spills; either way about 11 tok/s) |
| Qwen3-Coder-30B-A3B UD-IQ2_M | `-ngl auto -c 8192 -fa on -ctk q8_0 -ctv q8_0` (`--fit` moves experts to the CPU; 7.0 GiB VRAM, about 9 GiB RAM) |

### OpenArc config for the chosen model

```json
{
  "version": 1,
  "backends": {
    "local": {
      "provider": "local",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "model": "qwen2.5-coder-7b",
      "maxContextTokens": 16384,
      "outputFormat": "json"
    }
  },
  "compilation": { "defaultBackend": "local", "maxAttempts": 3, "context": { "initialLevel": 0, "expandOnFailure": true } }
}
```

No `fallbackBackend` pointing at a second local model: a fallback request would load a second model while llama-server holds the first, which is exactly the two-models-resident OOM. To try the fallback model, switch the server (`MODEL_KEY=seed-coder-8b ./apply.sh`) and set `"model": "seed-coder-8b"`.

## Other candidates (researched, not adopted)

| candidate | verdict | why |
|---|---|---|
| **vLLM** | not worth it | AMD's ROCm docs list gfx1102 (RX 7600) as supported for vLLM 0.23-0.29, through Docker images or `torch[device-gfx1102]` wheels. But vLLM preallocates `gpu_memory_utilization` of VRAM, wants AWQ/GPTQ weights rather than GGUF (its GGUF path is slow), and is built for batched throughput. OpenArc sends one request at a time, where llama.cpp is at least as fast. The image or wheels are 10-20 GB, and `/` has 4.7 GB. Not built. |
| SGLang | no | same profile as vLLM, with weaker RDNA3 support |
| ExLlamaV2 / TabbyAPI | no | CUDA-first; ROCm support is unofficial and needs a ROCm SDK on the host |
| MLC-LLM (Vulkan) | no | its own model format and compile step; no gain over llama.cpp Vulkan for GGUF models and grammar-constrained JSON |
| koboldcpp (Vulkan) | no | a llama.cpp fork with a UI; the same kernels, lagging upstream |
| LM Studio (`lms`, headless) | no | ships the same llama.cpp Vulkan/ROCm runtimes as a closed AppImage; adds nothing measurable here |
| Ollama 0.40.13 | no change | see above; tune the existing 0.40.5 instead |
| Ollama Vulkan backend (`OLLAMA_VULKAN=1`) | viable fallback | +7% generation over its ROCm path and 0.7 GiB less VRAM, still behind plain llama-server |

## What was not measured, and why

- **A true cold load for every stack.** Dropping the page cache needs root, so only the first loads of the day (Ollama 145 s, llama-server Vulkan 113 s, HIP 116 s) are real HDD reads; later loads (15-40 s) came from the page cache.
- **llama-bench at 4k depth for HIP and the coder models**, and the q8 KV / FA-off grid for 14B: skipped to save the GPU window. The 9B results show the pattern.
- **Ollama 0.40.13 side by side**: running newly downloaded executables is blocked here, and the release notes show no relevant change.
- **vLLM, SGLang, MLC, koboldcpp, LM Studio**: research only (see table).
- **Quality screen scope:** 8 of the 12 function exercises, OpenArc config A only (B/C not run), 1 seed. Gemma 4 12B's `code` arm was skipped (partial offload at about 11 tok/s made it about 2 min per task; its json arm and baseline were run). Configs B/C and all 12 exercises remain for a full run: `node run.mjs --dataset <ts-bench> --matrix /mnt/data/tools/llm-setup/screen/matrix-qwen2.5-coder-7b-json.json --out <new dir>`.
- **Ollama with the coder models**: the screen used llama-server only (one engine, so model differences are not engine differences). The engine comparison above used qwen3.5 9B.
- **HIP with rocWMMA flash attention** (`GGML_HIP_ROCWMMA_FATTN`): Fedora has no rocwmma-devel in the base repos, and HIP lost on generation speed anyway.

## Things that need sudo or a decision

- **Put the active model on the NVMe** to cut cold loads from about 2 min to about 5 s. `/` has 4.7 GB free and the 9B GGUF is 5.6 GB, so this needs space freed on `/` first (your decision). Then copy the GGUF to e.g. `~/models/` and change `-m` in `~/.config/systemd/user/llama-server.service`.
- Optional, for convenience only (no sudo is needed for the recommended setup): `sudo dnf install vulkan-tools vulkan-headers glslc` would allow native Vulkan builds without the container, and `vulkaninfo`.

## Files

| path | what |
|---|---|
| `/mnt/data/tools/llm-setup/apply.sh` | switch script (not applied) |
| `/mnt/data/tools/llm-setup/bench_openarc.py` | OpenArc-shaped request benchmark (TTFT, tok/s, JSON validity, VRAM, RSS) |
| `/mnt/data/tools/llm-setup/measure-llama.sh`, `measure-ollama.sh`, `gate.sh` | measurement drivers; `gate.sh` enforces "no other model job, 7 GB free" |
| `/mnt/data/tools/llm-setup/build-llama.sh`, `Containerfile.build` | source builds |
| `/mnt/data/tools/llm-setup/results/` | raw JSONL for every number above |
| `/mnt/data/tools/llm-setup/screen/` | model quality screen: `screen.sh <name> <gguf> [flags]`, per-model matrices, `rank.py` |
| `/mnt/data/projetos/openarc-wt-bench/bench/results/2026-10-31-model-screen/` | screen raw results |

### Disk usage after cleanup

| path | size | note |
|---|---|---|
| `/mnt/data/models/gguf/` | 9.8 GB new | qwen2.5-coder 7B (4.7), Seed-Coder 8B (5.1); the qwen3.5 9B file is a hard link to Ollama's blob (0 extra) |
| `/mnt/data/tools/llama.cpp/` | 0.9 GB | `src` (b12023) + `build-vulkan/bin` (3 static binaries) |
| `/mnt/data/tools/llm-setup/` | under 1 MB | scripts and results |
| deleted | | container image and storage (8.7 GB), HIP build, prebuilt downloads, 14B / Gemma 4 / Granite / Qwen3-Coder-30B GGUFs, the `ollama-test` store |

