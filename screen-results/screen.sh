#!/usr/bin/env bash
# Model screen on the selfhost tree: each model compiles the same 38 pending/stale regions from a clean main checkout.
# Usage: screen.sh <alias> <gguf> [extra llama-server args...]. One model resident at a time; memory gates from memory.
set -u
alias=$1; gguf=$2; shift 2
S=/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad
WT=/mnt/data/projetos/openarc-wt-self; OUT=$WT/screen-results/$alias; mkdir -p "$OUT"
BIN=/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server
avail() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
systemctl --user stop llama-server.service ollama.service 2>/dev/null
systemctl --user stop oa-screen.service 2>/dev/null; sleep 3
[ "$(avail)" -ge 6144 ] || { echo "gate: MemAvailable $(avail) MiB < 6 GiB, not starting" | tee "$OUT/result.txt"; exit 2; }
systemd-run --user --unit=oa-screen --collect -p MemoryMax=7G -p MemoryHigh=6G \
  "$BIN" -m "$gguf" -a "$alias" --host 127.0.0.1 --port 8080 -c 16384 -fa on -np 1 --cache-ram 0 --fit on \
  --jinja --reasoning off --no-webui "$@" >/dev/null
for i in $(seq 1 180); do curl -sf http://127.0.0.1:8080/health >/dev/null && break; sleep 2; done
curl -sf http://127.0.0.1:8080/health >/dev/null || { echo "server did not come up" | tee "$OUT/result.txt"; journalctl --user -u oa-screen -n 40 --no-pager > "$OUT/server.log"; systemctl --user stop oa-screen; exit 3; }
journalctl --user -u oa-screen --no-pager | grep -iE "offload|fit|layers|VRAM|buffer size" | tail -20 > "$OUT/server.log"
cd "$WT/selfhost"
git checkout -q -- . && git clean -fdq -- .openarc/cache src && rm -f .openarc/failed.json
sed -i "s/\"model\": \"[^\"]*\"/\"model\": \"$alias\"/" openarc.config.json
t0=$(date +%s)
node --no-warnings ../stage0/src/main.ts compile --keep-going $(cat $S/screen-ids.txt) > "$OUT/compile.log" 2>&1 &
pid=$!
while kill -0 $pid 2>/dev/null; do
  if [ "$(avail)" -lt 1536 ]; then echo "gate: MemAvailable $(avail) MiB < 1.5 GiB, aborting" >> "$OUT/compile.log"; kill $pid; systemctl --user stop oa-screen; fi
  sleep 5
done
wait $pid; code=$?
t1=$(date +%s)
node --no-warnings ../stage0/src/main.ts graph > "$OUT/graph.txt" 2>&1
verified=$(grep -cE ": ✓" "$OUT/compile.log"); e082=$(grep -c "OARC-E082" "$OUT/compile.log")
states=$(grep -Fxf $S/screen-ids.txt <(awk '{print $1}' "$OUT/graph.txt") >/dev/null; awk 'NR==FNR{ids[$1];next} ($1 in ids){print $3}' $S/screen-ids.txt "$OUT/graph.txt" | sort | uniq -c | tr '\n' ' ')
echo "alias=$alias exit=$code seconds=$((t1-t0)) checkmarks=$verified e082=$e082 states_of_38: $states | $(tail -1 "$OUT/compile.log")" | tee "$OUT/result.txt"
git diff --stat -- src | tail -1 >> "$OUT/result.txt"
git diff -- src > "$OUT/src.diff"
git checkout -q -- . && git clean -fdq -- .openarc/cache src && rm -f .openarc/failed.json
systemctl --user stop oa-screen 2>/dev/null
