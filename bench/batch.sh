#!/usr/bin/env bash
# Batching run for OpenArc issue #19 (see matrix-batch.json and results/2026-11-01-batch/summary.md):
# arms A, E-resample, D on open-arc 0.9.2, paired with results/2026-11-01-efficiency (0.9.1).
# 1. waits (poll 2 min, up to 3 h) until no run.mjs runs from $FOREIGN, no llama-server runs and Ollama has no model loaded;
# 2. starts one llama-server (Vulkan, qwen2.5-coder-7b Q4_K_M, the model screen's flags) on port 18080;
# 3. runs every arm with seeds 1, 2, 3 (run.mjs resumes: rerun this script after an interruption);
# 4. stops the server and writes tables.md.
# usage: bench/batch.sh <ts-bench clone> <work dir> <open-arc 0.9.2 tgz>
set -euo pipefail
DATASET=$1 WORK=$2 OA=$3
BENCH=$(cd "$(dirname "$0")" && pwd)
OUT=$BENCH/results/2026-11-01-batch
FOREIGN=${FOREIGN:-/mnt/data/projetos/openarc-wt-bench}
LLAMA=/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server
GGUF=/mnt/data/models/gguf/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf
FLAGS=(-ngl 99 -c 8192 -fa on -np 1 --cache-ram 0 --reasoning off --jinja --no-webui)
mkdir -p "$OUT"
log() { echo "$(date -Is) $*" | tee -a "$OUT/driver.log"; }

busy() {
  pgrep -x llama-server >/dev/null && { echo "llama-server running"; return 0; }
  [[ $(curl -s localhost:11434/api/ps 2>/dev/null) == *'"name"'* ]] && { echo "ollama has a model loaded"; return 0; }
  for p in $(pgrep -f "run.mjs" || true); do
    [[ $(readlink "/proc/$p/cwd" 2>/dev/null) == "$FOREIGN"* ]] && { echo "run.mjs pid $p in $FOREIGN"; return 0; }
  done
  return 1
}
for i in $(seq 0 90); do
  why=$(busy) || break
  (( i == 90 )) && { log "gave up after 3 h: $why"; exit 3; }
  (( i % 5 == 0 )) && log "waiting: $why"
  sleep 120
done
avail_gb() { awk '/MemAvailable/ {printf "%d", $2/1048576}' /proc/meminfo; }
(( $(avail_gb) >= 6 )) || { log "MemAvailable $(avail_gb) GB < 6 GB, not starting"; exit 4; }

log "starting llama-server: $GGUF ${FLAGS[*]} --port 18080"
"$LLAMA" -m "$GGUF" -a qwen2.5-coder-7b --host 127.0.0.1 --port 18080 "${FLAGS[@]}" > "$OUT/server-qwen2.5-coder-7b.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null; log "llama-server stopped"' EXIT
for i in $(seq 1 120); do curl -sf http://127.0.0.1:18080/health >/dev/null && break; sleep 2; done
curl -sf http://127.0.0.1:18080/health >/dev/null || { log "server did not come up"; exit 5; }
log "server ready"
# MemAvailable watchdog (run.mjs aborts too, but only between its own samples): below 1.5 GB, stop everything
( while kill -0 $SERVER 2>/dev/null; do
    (( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) < 1572864 )) && { log "MemAvailable < 1.5 GB: stopping"; ps -eo pid,args | awk '$2 ~ /node$/ && /run\.mjs/ && /matrix-batch/ {print $1}' | xargs -r kill; kill $SERVER; }
    sleep 2
  done ) &

for seed in 1 2 3; do
  log "seed $seed"
  node "$BENCH/run.mjs" --dataset "$DATASET" --work "$WORK" --oa "$OA" --matrix "$BENCH/matrix-batch.json" \
    --out "$OUT" --seed "$seed" --port 18440 2>&1 | tee -a "$OUT/stdout.log"
done
node "$BENCH/summarize.mjs" "$OUT" > /dev/null
log "done"
