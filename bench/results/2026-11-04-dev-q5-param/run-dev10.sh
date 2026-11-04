#!/usr/bin/env bash
# Dev rerun with #57 (redeclared params), otherwise as dev8.
set -u -o pipefail
S=/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad; D=$S/dev10
B=/mnt/data/projetos/openarc-wt-param/bench; BIN=/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server; G=/mnt/data/models/gguf
TGZ=$(ls $D/open-arc-0.10.0-*.tgz)
trap 'systemctl --user stop oa-screen 2>/dev/null; systemctl --user start llama-server.service 2>/dev/null' EXIT
avail() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
cd $B
systemctl --user stop llama-server.service ollama.service oa-screen.service 2>/dev/null; sleep 3
[ "$(avail)" -ge 6144 ] || { echo "gate: MemAvailable $(avail) MiB"; exit 2; }
up() {
  systemctl --user stop oa-screen 2>/dev/null; sleep 2
  systemd-run --user --unit=oa-screen --collect -p MemoryMax=7G -p MemoryHigh=6G "$BIN" -m $G/Qwen3.5-9B-Q5_K_M.gguf -a qwen3.5-9b-q5km --host 127.0.0.1 --port 8080 -c 8192 -fa on -np 1 --cache-ram 0 --fit on --jinja --reasoning off --no-webui >/dev/null
  for i in $(seq 1 180); do curl -sf http://127.0.0.1:8080/health >/dev/null && break; sleep 2; done
  curl -sf http://127.0.0.1:8080/health >/dev/null || { echo "server did not come up"; exit 3; }
}
up || exit 3
for s in 1 2 3; do
  curl -sf http://127.0.0.1:8080/health >/dev/null || { echo "server down before seed $s, restarting $(date +%T)"; up || exit 3; }
  node run.mjs --dataset $S/ts-bench --work $S/devwork --oa $TGZ --matrix $D/matrix.json --set dev --out $D/out --seed $s >> $D/run.log 2>&1 || echo "seed $s exit $?"
done
node summarize.mjs $D/out >/dev/null 2>&1
echo "DEV10-DONE $(date +%T)"
