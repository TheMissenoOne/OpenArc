#!/bin/sh
# Download the MultiPL-E TypeScript translations of HumanEval and MBPP (nuprl/MultiPL-E, MIT) at a pinned revision
# and convert the parquet files to JSONL (one problem per line). Training-pool input only: see train-pool.md.
# Dataset content is third-party and untrusted: it stays in the target dir, never in this repo.
# Usage: ./fetch-multipl-e.sh <empty target dir>     (needs curl and uv; pyarrow is fetched into uv's cache)
set -eu
TARGET=${1:?usage: fetch-multipl-e.sh <target dir>}
REV=28441b6024e71d4a1c1c0f6bf171c935cd5a43f2   # nuprl/MultiPL-E main, last modified 2025-07-15
mkdir -p "$TARGET"
for c in humaneval-ts mbpp-ts; do
  [ -f "$TARGET/$c.parquet" ] || curl -sSfL -o "$TARGET/$c.parquet" "https://huggingface.co/datasets/nuprl/MultiPL-E/resolve/$REV/$c/test-00000-of-00001.parquet"
  (cd / && uv run -q --no-project --with pyarrow==21.0.0 python -I -c '
import sys, json, pyarrow.parquet as pq
with open(sys.argv[2], "w") as f:
    for r in pq.read_table(sys.argv[1]).to_pylist(): f.write(json.dumps(r) + "\n")' "$TARGET/$c.parquet" "$TARGET/$c.jsonl")
done
echo "$REV" > "$TARGET/REVISION"
wc -l "$TARGET"/*.jsonl
