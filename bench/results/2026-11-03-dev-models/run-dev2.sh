#!/usr/bin/env bash
# Dev set, A vs D, three models on current main; one llama-server per model, seeds 1-3. Memory gates as in screen.sh.
set -u -o pipefail
S=/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad; D=$S/dev2
B=/mnt/data/projetos/openarc/bench; BIN=/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server; G=/mnt/data/models/gguf
OUT=results/2026-11-03-dev-models
trap 'systemctl --user stop oa-screen 2>/dev/null; systemctl --user start llama-server.service 2>/dev/null' EXIT
avail() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
cd $B
for spec in "qwen2.5-coder-7b Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf" "seed-coder-8b Seed-Coder-8B-Instruct-Q4_K_M.gguf" "qwen3.5-9b Qwen3.5-9B-Q4_K_M.gguf"; do
  set -- $spec; alias=$1; gguf=$G/$2
  systemctl --user stop llama-server.service ollama.service oa-screen.service 2>/dev/null; sleep 3
  [ "$(avail)" -ge 6144 ] || { echo "gate: MemAvailable $(avail) MiB < 6 GiB before $alias"; exit 2; }
  systemd-run --user --unit=oa-screen --collect -p MemoryMax=7G -p MemoryHigh=6G "$BIN" -m "$gguf" -a "$alias" --host 127.0.0.1 --port 8080 -c 8192 -fa on -np 1 --cache-ram 0 --fit on --jinja --reasoning off --no-webui >/dev/null
  for i in $(seq 1 180); do curl -sf http://127.0.0.1:8080/health >/dev/null && break; sleep 2; done
  systemctl --user is-active -q oa-screen && curl -sf http://127.0.0.1:8080/health >/dev/null || { echo "server for $alias did not come up"; exit 3; }
  for s in 1 2 3; do
    node run.mjs --dataset $S/ts-bench --work $S/devwork --oa $D/open-arc-0.10.0-main3eabb01.tgz --matrix $D/matrix-$alias.json --set dev --out $OUT --seed $s >> $D/run.log 2>&1 || echo "$alias seed $s exit $?"
  done
  echo "$alias done $(date +%T)"
done
echo DEV2-DONE
