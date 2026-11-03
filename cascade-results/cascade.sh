#!/usr/bin/env bash
# Cascade on the selfhost tree: each model compiles what is still pending/stale, verified regions are pinned to it via
# openarc.config.json regions[id].backend. One model resident at a time; memory gates as in screen.sh.
set -u
S=/tmp/claude-1000/-mnt-data-projetos/0a52dddd-ec03-4d58-8441-c8ccfe4d6411/scratchpad
WT=/mnt/data/projetos/openarc-wt-cascade; OUT=$WT/cascade-results; mkdir -p "$OUT"
BIN=/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server; G=/mnt/data/models/gguf
avail() { awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo; }
cd "$WT/selfhost"
python3 -I - <<'PY'
import json; f="openarc.config.json"; c=json.load(open(f))
base=c["backends"]["local"]
for name,model in [("seed","seed-coder-8b"),("qwen35","qwen3.5-9b"),("q14","qwen2.5-coder-14b-iq3m")]: c["backends"][name]={**base,"model":model}
c.setdefault("regions",{}); json.dump(c,open(f,"w"),indent=2); open(f,"a").write("\n")
PY
remaining() { node --no-warnings ../stage0/src/main.ts graph 2>/dev/null | awk '$3=="pending"||$3=="stale"{print $1}'; }
remaining > "$OUT/ids-0.txt"
pass=0
for spec in "seed seed-coder-8b $G/Seed-Coder-8B-Instruct-Q4_K_M.gguf" "qwen35 qwen3.5-9b $G/Qwen3.5-9B-Q4_K_M.gguf" "q14 qwen2.5-coder-14b-iq3m $G/Qwen2.5-Coder-14B-Instruct-IQ3_M.gguf -ctk q8_0 -ctv q8_0"; do
  set -- $spec; be=$1; alias=$2; gguf=$3; shift 3; pass=$((pass+1))
  ids=$(cat "$OUT/ids-$((pass-1)).txt"); [ -n "$ids" ] || break
  python3 -I - "$be" $ids <<'PY'
import json,sys; f="openarc.config.json"; c=json.load(open(f)); be=sys.argv[1]
for i in sys.argv[2:]: c["regions"][i]={"backend":be}
json.dump(c,open(f,"w"),indent=2); open(f,"a").write("\n")
PY
  systemctl --user stop llama-server.service ollama.service oa-screen.service 2>/dev/null; sleep 3
  [ "$(avail)" -ge 6144 ] || { echo "gate: MemAvailable $(avail) MiB < 6 GiB" | tee -a "$OUT/result.txt"; exit 2; }
  systemd-run --user --unit=oa-screen --collect -p MemoryMax=7G -p MemoryHigh=6G "$BIN" -m "$gguf" -a "$alias" --host 127.0.0.1 --port 8080 -c 16384 -fa on -np 1 --cache-ram 0 --fit on --jinja --reasoning off --no-webui "$@" >/dev/null
  for i in $(seq 1 180); do curl -sf http://127.0.0.1:8080/health >/dev/null && break; sleep 2; done
  t0=$(date +%s)
  node --no-warnings ../stage0/src/main.ts compile --keep-going $ids > "$OUT/pass$pass-$be.log" 2>&1 &
  pid=$!
  while kill -0 $pid 2>/dev/null; do
    if [ "$(avail)" -lt 1536 ]; then echo "gate: MemAvailable < 1.5 GiB, aborting" >> "$OUT/pass$pass-$be.log"; kill $pid; fi
    sleep 5
  done
  wait $pid
  node --no-warnings ../stage0/src/main.ts graph > "$OUT/graph-$pass.txt" 2>&1
  awk 'NR==FNR{ids[$1];next} ($1 in ids)&&($3=="pending"||$3=="stale"){print $1}' <(echo "$ids" | tr ' ' '\n') "$OUT/graph-$pass.txt" > "$OUT/ids-$pass.txt"
  python3 -I - $(cat "$OUT/ids-$pass.txt") <<'PY'
import json,sys; f="openarc.config.json"; c=json.load(open(f))
for i in sys.argv[1:]: c["regions"].pop(i,None)
json.dump(c,open(f,"w"),indent=2); open(f,"a").write("\n")
PY
  echo "pass $pass $be: $(echo $ids | wc -w) in, $(wc -l < "$OUT/ids-$pass.txt") left, $(( $(date +%s)-t0 ))s | $(tail -1 "$OUT/pass$pass-$be.log")" | tee -a "$OUT/result.txt"
  systemctl --user stop oa-screen 2>/dev/null
done
systemctl --user start llama-server.service
echo CASCADE-DONE
