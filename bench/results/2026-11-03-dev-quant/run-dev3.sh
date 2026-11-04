#!/usr/bin/env bash
# Follow-ups to the 2026-11-03 dev run, same tarball and seeds: Qwen3.5 Q4 variants (line breaks kept, plain-code
# output), then a quantization ladder. One llama-server at a time, memory gates as in run-dev2.sh.
set -u -o pipefail
S=/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad; D=$S/dev3
B=/mnt/data/projetos/openarc/bench; BIN=/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server; G=/mnt/data/models/gguf
TGZ=$S/dev2/open-arc-0.10.0-main3eabb01.tgz
trap 'systemctl --user stop oa-screen 2>/dev/null; systemctl --user start llama-server.service 2>/dev/null' EXIT
avail() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
cd $B
for spec in "q4-variants qwen3.5-9b Qwen3.5-9B-Q4_K_M.gguf results/2026-11-03-dev-variants" \
            "qwen3.5-9b-q3km qwen3.5-9b-q3km Qwen3.5-9B-Q3_K_M.gguf results/2026-11-03-dev-quant" \
            "qwen3.5-9b-q5km qwen3.5-9b-q5km Qwen3.5-9B-Q5_K_M.gguf results/2026-11-03-dev-quant" \
            "qwen3.5-9b-q6k qwen3.5-9b-q6k Qwen3.5-9B-Q6_K.gguf results/2026-11-03-dev-quant" \
            "seed-coder-8b-q6k seed-coder-8b-q6k Seed-Coder-8B-Instruct-Q6_K.gguf results/2026-11-03-dev-quant"; do
  set -- $spec; name=$1; alias=$2; gguf=$G/$3; OUT=$4
  for i in $(seq 1 360); do [ -f "$gguf" ] && break; sleep 10; done
  [ -f "$gguf" ] || { echo "missing $gguf"; continue; }
  systemctl --user stop llama-server.service ollama.service oa-screen.service 2>/dev/null; sleep 3
  [ "$(avail)" -ge 6144 ] || { echo "gate: MemAvailable $(avail) MiB < 6 GiB before $name"; exit 2; }
  systemd-run --user --unit=oa-screen --collect -p MemoryMax=7G -p MemoryHigh=6G "$BIN" -m "$gguf" -a "$alias" --host 127.0.0.1 --port 8080 -c 8192 -fa on -np 1 --cache-ram 0 --fit on --jinja --reasoning off --no-webui >/dev/null
  for i in $(seq 1 180); do curl -sf http://127.0.0.1:8080/health >/dev/null && break; sleep 2; done
  systemctl --user is-active -q oa-screen && curl -sf http://127.0.0.1:8080/health >/dev/null || { echo "server for $name did not come up"; continue; }
  journalctl --user -u oa-screen --no-pager 2>/dev/null | grep -iE "offload|layers" | tail -3 > $D/offload-$name.txt
  for s in 1 2 3; do
    node run.mjs --dataset $S/ts-bench --work $S/devwork --oa $TGZ --matrix $D/matrix-$name.json --set dev --out $OUT --seed $s >> $D/run.log 2>&1 || echo "$name seed $s exit $?"
  done
  echo "$name done $(date +%T)"
done
echo DEV3-DONE
