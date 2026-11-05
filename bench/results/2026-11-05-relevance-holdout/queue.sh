#!/usr/bin/env bash
# Relevance on the holdout set: rounds seeds 1-5, then batches seeds 1-3. Each (layout, seed, arm) is its own dir with a DONE marker: rerun this script to resume.
set -u
Q=/mnt/data/tools/ft/queue/relmore; R=/mnt/data/tools/ft/runs/relevance-holdout; W=/mnt/data/tools/ft/work-evolve/relmore
cd /mnt/data/projetos/openarc-wt-relevance2/bench
export BENCH_EXERCISES=/mnt/data/tools/ft/data/holdout/exercises.json
ready() { systemctl --user start llama-server.service; for i in $(seq 1 360); do curl -sf http://127.0.0.1:8080/health | grep -q ok && return 0; sleep 2; done; return 1; }
one() { # layout seed arm flags...
  local out=$R/$1/s$2-$3; [ -f "$out/DONE" ] && return 0
  [ "$(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo)" -lt 6 ] && ! curl -sf http://127.0.0.1:8080/health >/dev/null && { echo "MemAvailable below 6 GiB"; exit 4; }
  ready || { echo "server not ready"; exit 3; }
  rm -rf "$out" "$W"; mkdir -p "$out"
  node evolve-multi.mjs --dataset /mnt/data/tools/ft/data/holdout --work "$W" --oa $Q/open-arc-0.11.0.tgz --matrix $Q/matrix.json --configs "$3" --out "$out" --seed "$2" "${@:4}" >> $Q/run.log 2>&1 && touch "$out/DONE" && echo "$1 s$2 $3 done $(date +%T)"
  rm -rf "$W"
}
for s in 1 2 3 4 5; do for a in Cx Cr; do one rounds $s $a --pack 6 --rounds; done; done
for s in 1 2 3; do for a in Cx Cr; do one burst $s $a --pack 6; done; done
echo RELMORE-DONE $(date +%T)
