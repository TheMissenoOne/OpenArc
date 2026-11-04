#!/usr/bin/env bash
# After run-dev3.sh: (1) deps-suggest bench on Qwen3.5-9B Q4 via llama-server; (2) type-constrained decoding on the
# 7B (typed server, llama-cpp-python Vulkan), constrained then unconstrained control, dev set, seeds 1-3.
set -u -o pipefail
S=/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad; D=$S/dev4
BIN=/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server; G=/mnt/data/models/gguf
TYPED=/mnt/data/projetos/openarc-wt-typed/bench/typed; DEPS=/mnt/data/projetos/openarc-wt-deps
TGZ=$S/dev2/open-arc-0.10.0-main3eabb01.tgz; B=/mnt/data/projetos/openarc/bench
trap 'systemctl --user stop oa-screen oa-typed 2>/dev/null; systemctl --user start llama-server.service 2>/dev/null' EXIT
avail() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
stopall() { systemctl --user stop llama-server.service ollama.service oa-screen.service oa-typed.service 2>/dev/null; sleep 3; }
while pgrep -f run-dev3.sh >/dev/null; do sleep 30; done
# 1. deps
stopall; [ "$(avail)" -ge 6144 ] || { echo "gate before deps: $(avail) MiB"; exit 2; }
systemd-run --user --unit=oa-screen --collect -p MemoryMax=7G -p MemoryHigh=6G "$BIN" -m $G/Qwen3.5-9B-Q4_K_M.gguf -a qwen3.5-9b --host 127.0.0.1 --port 8080 -c 16384 -fa on -np 1 --cache-ram 0 --fit on --jinja --reasoning off --no-webui >/dev/null
for i in $(seq 1 180); do curl -sf http://127.0.0.1:8080/health >/dev/null && break; sleep 2; done
(cd $DEPS && node bench/deps/run.mjs --base-url http://127.0.0.1:8080/v1 --model qwen3.5-9b --max 2 --backend-json '{"maxContextTokens":16384}' --out bench/results/2026-11-03-deps) >> $D/deps.log 2>&1 || echo "deps exit $?"
echo "deps done $(date +%T)"
# 2. typed
if ! ls $TYPED/.venv/lib/python3.14/site-packages/llama_cpp/lib | grep -qi vulkan; then echo "typed: no Vulkan build, skipped"; exit 0; fi
for cfg in A-typed A-typed-off; do
  stopall; [ "$(avail)" -ge 6144 ] || { echo "gate before $cfg: $(avail) MiB"; exit 2; }
  off=0; [ $cfg = A-typed-off ] && off=1
  systemd-run --user --unit=oa-typed --collect -p MemoryMax=7G -p MemoryHigh=6G --working-directory=$TYPED \
    -E TYPED_MODEL=$G/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf -E TYPED_NGL=-1 -E TYPED_CTX=8192 -E TYPED_PORT=8091 -E TYPED_TIMEOUT=300 -E TYPED_OFF=$off \
    $TYPED/.venv/bin/python server.py >/dev/null
  for i in $(seq 1 180); do curl -sf http://127.0.0.1:8091/v1/models >/dev/null && break; sleep 2; done
  systemctl --user is-active -q oa-typed || { echo "typed server ($cfg) did not come up"; journalctl --user -u oa-typed --no-pager | tail -20; continue; }
  for s in 1 2 3; do
    (cd $B && node run.mjs --dataset $S/ts-bench --work $S/devwork --oa $TGZ --matrix $D/matrix-$cfg.json --set dev --out results/2026-11-03-dev-typed --seed $s) >> $D/typed.log 2>&1 || echo "$cfg seed $s exit $?"
  done
  echo "$cfg done $(date +%T)"
done
echo DEV4-DONE
