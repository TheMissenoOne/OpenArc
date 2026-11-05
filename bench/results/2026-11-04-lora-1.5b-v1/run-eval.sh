#!/usr/bin/env bash
# #63 eval, resumable: run.mjs skips what tasks.jsonl already holds. One model resident at a time.
set -u
Q=/mnt/data/tools/ft/queue; R=/mnt/data/tools/ft/runs; BIN=/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server; G=/mnt/data/models/gguf-small/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
TGZ=$(ls $Q/open-arc-*.tgz | tail -1)
trap 'systemctl --user stop oa-screen 2>/dev/null; systemctl --user start llama-server.service 2>/dev/null' EXIT
systemctl --user stop llama-server.service ollama.service oa-screen.service 2>/dev/null; sleep 3
[ "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)" -ge 6144 ] || { echo "gate: low memory"; exit 2; }
cd /mnt/data/projetos/openarc/bench
for spec in "qwen2.5-coder-1.5b:" "qwen2.5-coder-1.5b-lora-v1:--lora $R/lora-1.5b-v1.gguf"; do
  m=${spec%%:*}; extra=${spec#*:}
  for s in 1 2 3; do
    for try in 1 2 3; do
      if ! curl -sf http://127.0.0.1:8080/health >/dev/null || [ "$(cat $Q/up 2>/dev/null)" != "$m" ]; then
        systemctl --user stop oa-screen 2>/dev/null; sleep 2
        systemd-run --user --unit=oa-screen --collect -p MemoryMax=7G -p MemoryHigh=6G "$BIN" -m "$G" $extra -a "$m" --host 127.0.0.1 --port 8080 -c 8192 -fa on -np 1 --cache-ram 0 --fit on --jinja --no-webui >/dev/null
        for i in $(seq 1 90); do curl -sf http://127.0.0.1:8080/health >/dev/null && break; sleep 2; done
        echo "$m" > $Q/up
      fi
      node run.mjs --dataset /mnt/data/tools/ft/data/ts-bench --work /mnt/data/tools/ft/work-eval --oa "$TGZ" --matrix $Q/eval-matrix.json --set dev --models "$m" --out $R/eval-1.5b-v1 --seed $s >> $Q/eval.log 2>&1 && break
      echo "$m seed $s try $try failed $(date +%T)"
    done
  done
done
rm -f $Q/up; echo "EVAL-DONE $(date +%T)"
