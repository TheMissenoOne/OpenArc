// Plain-assert check of src/dirwatch.ts against the real filesystem: a file replaced by rename (as txn.commit
// does) must still report later in-place writes, and a subdirectory created after start must be watched.
// Run: node tests/watch-fs.check.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { watchDirs } from "../src/dirwatch.ts";

const root = mkdtempSync(`${tmpdir()}/openarc-watch-fs-`); // honours TMPDIR
mkdirSync(`${root}/src`);
mkdirSync(`${root}/.openarc/txn`, { recursive: true });
writeFileSync(`${root}/src/t.ts`, "a");

const seen: string[] = [];
const w = watchDirs(root, ["src", "tests/fakes"], (p) => seen.push(p)); // tests/fakes is missing: skipped
const tick = () => new Promise((r) => setTimeout(r, 250));
const sawAfter = async (n: number, path: string) => {
  for (let i = 0; i < 8 && !seen.slice(n).includes(path); i++) await tick();
  return seen.slice(n).includes(path);
};

try {
  await tick();
  writeFileSync(`${root}/.openarc/txn/s`, "b"); // the commit: staged file renamed over the target
  renameSync(`${root}/.openarc/txn/s`, `${root}/src/t.ts`);
  assert.ok(await sawAfter(0, "src/t.ts"), "the rename itself is reported");

  let n = seen.length;
  writeFileSync(`${root}/src/t.ts`, "c"); // the user's next save, in place
  assert.ok(await sawAfter(n, "src/t.ts"), "an in-place write after a rename-replace is reported");

  n = seen.length;
  mkdirSync(`${root}/src/sub`);
  await tick();
  writeFileSync(`${root}/src/sub/x.ts`, "d");
  assert.ok(await sawAfter(n, "src/sub/x.ts"), "a subdirectory created after start is watched");

  w.rewatch(["src"]); // what watch does after a commit; must keep working
  n = seen.length;
  writeFileSync(`${root}/src/t.ts`, "e");
  assert.ok(await sawAfter(n, "src/t.ts"), "rewatch keeps the directory watched");
  console.log("watch-fs.check: ok");
} finally {
  w.close();
  rmSync(root, { recursive: true, force: true });
}
