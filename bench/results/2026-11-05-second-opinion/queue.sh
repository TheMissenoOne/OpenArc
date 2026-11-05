#!/usr/bin/env bash
# Second-opinion bodies: 3 models x seeds 1-3. Each body has its own dir and DONE marker: rerun to resume. One model resident at a time; restores llama-server.service at the end.
set -u
REPO=/mnt/data/projetos/openarc-wt-second; OUT=/mnt/data/tools/ft/runs/second-opinion; LOG=$OUT/queue.log; BIN=/mnt/data/tools/llama.cpp/build-vulkan/bin/llama-server; G=/mnt/data/models/gguf
mkdir -p "$OUT"
IDS="model.parseOutput p2p.onGossip p2p.broadcast p2p.peerTable p2p.handshake p2p.encodeVarint p2p.decodeLengthPrefixed"
mem() { awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo; }
serve() { # gguf alias
  systemctl --user stop llama-server.service so-llama.service 2>/dev/null; sleep 3
  [ "$(mem)" -lt 6 ] && { echo "MemAvailable below 6 GiB" | tee -a "$LOG"; exit 4; }
  systemd-run --user --unit=so-llama -p MemoryHigh=3G -p MemoryMax=4G "$BIN" -m "$G/$1" -a "$2" --host 127.0.0.1 --port 8080 --fit on -c 16384 -fa on -np 1 --cache-ram 0 --sleep-idle-seconds 900 --jinja --reasoning off --no-webui >/dev/null
  for i in $(seq 1 180); do curl -sf http://127.0.0.1:8080/health | grep -q ok && return 0; sleep 2; done
  echo "server not ready: $2" | tee -a "$LOG"; exit 3
}
body() { # backend seed
  local d="$OUT/$1-s$2"; [ -f "$d/DONE" ] && return 0
  [ "$(mem)" -lt 2 ] && { echo "MemAvailable below 1.5 GiB" | tee -a "$LOG"; exit 4; }
  rm -rf "$d"; mkdir -p "$d"
  (cd "$REPO/selfhost" && tar --exclude=node_modules --exclude=.openarc/cache --exclude=.openarc/failed.json -cf - .) | tar -xf - -C "$d"
  ln -s "$REPO/selfhost/node_modules" "$d/node_modules"
  # stage0 reads tests/fakes etc. through the project copy; the backend and sampling go in the copy's config only
  node -e '
    const fs=require("fs"),[,f,b,s,...ids]=process.argv,c=JSON.parse(fs.readFileSync(f));
    Object.assign(c.backends[b],{temperature:0.6,seed:+s}); for(const id of ids)c.regions[id]={backend:b};
    fs.writeFileSync(f,JSON.stringify(c,null,2))' "$d/openarc.config.json" "$1" "$2" $IDS
  # release alone keeps a body whose spec is unchanged, so every target goes back to arc.todo first
  node -e '
    const fs=require("fs"),[,d,...ids]=process.argv;
    for(const id of ids){const f=d+(id.startsWith("model.")?"/src/model.ts":"/src/palette/p2p.ts"),t=fs.readFileSync(f,"utf8");
      const m=new RegExp("// @openarc:begin "+id.replace(".","\\.")+"\\n(export const [^\\n]*?=) (?:async )?(\\([^)]*\\)) =>[\\s\\S]*?// @openarc:end "+id.replace(".","\\.")).exec(t);
      if(!m)throw new Error("no region "+id);
      fs.writeFileSync(f,t.replace(m[0],`// @openarc:begin ${id}\n${m[1]} ${m[2]} => arc.todo("${id}");\n// @openarc:end ${id}`))}' "$d" $IDS
  ( cd "$d" && for id in $IDS; do node --no-warnings "$REPO/stage0/src/main.ts" release "$id"; done; ok=0; for id in $IDS; do timeout 1200 node --no-warnings "$REPO/stage0/src/main.ts" compile "$id" && ok=$((ok+1)); done; echo "regions compiled: $ok" ) > "$d/compile.log" 2>&1
  # one region at a time: compile commits nothing when any region in the call fails. onGossip comes before broadcast, which calls it.
  echo "$1 s$2 $(tail -n 1 "$d/compile.log") $(date +%T)" | tee -a "$LOG"
  ( cd "$REPO/stage0" && node --no-warnings ../bench/results/2026-11-05-second-opinion/compare.ts "$d" --mode both --runs 2000 ) > "$d/compare.jsonl" 2>> "$LOG" && touch "$d/DONE"
}
run_model() { local need=0; for s in 1 2 3; do [ -f "$OUT/$3-s$s/DONE" ] || need=1; done; [ $need = 0 ] && return 0; serve "$1" "$2"; for s in 1 2 3; do body "$3" "$s"; done; }
run_model Qwen3.5-9B-Q5_K_M.gguf qwen3.5-9b qwen35
run_model Seed-Coder-8B-Instruct-Q6_K.gguf seed-coder-8b seed
run_model Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf qwen2.5-coder-7b local
systemctl --user stop so-llama.service; systemctl --user start llama-server.service
echo "SECOND-OPINION-DONE $(date +%T)" | tee -a "$LOG"
