#!/bin/sh
# Clone ts-bench (MIT, github.com/laiso/ts-bench) and its Exercism submodule (MIT, Exercism) at pinned commits.
# Exercise content is third-party: it stays in the clone, never in this repo.
# Usage: ./fetch-dataset.sh <target dir>
set -eu
TARGET=${1:?usage: fetch-dataset.sh <target dir>}
TS_BENCH_COMMIT=dcf7d44fa47f05a2849090e5e16fe67e8af96eff   # ts-bench main, 2026-08-15
EXERCISM_COMMIT=ab2d84eda572061e10a8e1ac8c1a662fa859284e   # repos/exercism-typescript submodule at that commit
[ -d "$TARGET/.git" ] || git clone -q https://github.com/laiso/ts-bench "$TARGET"
git -C "$TARGET" checkout -q "$TS_BENCH_COMMIT"
git -C "$TARGET" submodule update --init repos/exercism-typescript
test "$(git -C "$TARGET/repos/exercism-typescript" rev-parse HEAD)" = "$EXERCISM_COMMIT"
echo "ts-bench at $TS_BENCH_COMMIT, exercism-typescript at $EXERCISM_COMMIT in $TARGET"
