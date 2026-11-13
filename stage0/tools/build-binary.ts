// Build the standalone download: build/openarc-<version>-<os>-<arch>.tar.gz, the npm package (tools/build.ts) next to
// the Node runtime running this script and a launcher, so a machine without Node or npm can run `openarc`.
// Layout: openarc-<v>-<os>-<arch>/bin/openarc (sh launcher), bin/node, lib/open-arc/ (the package, with
// node_modules/typescript), LICENSE (OpenArc's), LICENSE.node (Node's).
// Not a Node single executable: on Node 25 a SEA loads only built-in modules, cannot act as the Node runtime the example
// sandbox spawns, and the harness and record.mjs must be files on disk; shipping node itself keeps every path the npm
// install takes (process.execPath is a real node) unchanged.
// ponytail: POSIX only (sh launcher, tar.gz); Windows would need a .cmd launcher and a zip.
// Usage: node tools/build-binary.ts   (run from stage0/, with the Node version to ship)
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

if (process.platform === "win32") throw new Error("build-binary: POSIX only (the launcher is a sh script)");
const root = process.cwd();
execFileSync(process.execPath, [`${root}/tools/build.ts`], { stdio: "inherit" });
const version = JSON.parse(readFileSync(`${root}/build/package.json`, "utf8")).version as string;
const name = `openarc-${version}-${process.platform}-${process.arch}`;
const stage = join(root, "build", "binary", name);
rmSync(join(root, "build", "binary"), { recursive: true, force: true });
mkdirSync(join(stage, "bin"), { recursive: true });

const pkg = join(stage, "lib", "open-arc");
for (const f of ["package.json", "README.md", "dist", "palette", "integrations"]) cpSync(join(root, "build", f), join(pkg, f), { recursive: true });
// the exact typescript the package was built against (build.ts pins ^ to it); dereference: node_modules may be links
cpSync(join(root, "node_modules", "typescript"), join(pkg, "node_modules", "typescript"), { recursive: true, dereference: true });
cpSync(process.execPath, join(stage, "bin", "node"));
const nodeLicense = join(dirname(dirname(process.execPath)), "LICENSE");
if (existsSync(nodeLicense)) cpSync(nodeLicense, join(stage, "LICENSE.node"));
cpSync(join(root, "..", "LICENSE"), join(stage, "LICENSE"));
// Follows symlinks to itself, so a link from ~/.local/bin works. The same flags the npm bin gets through its shebang,
// plus --no-warnings as setup's wrapper uses.
writeFileSync(join(stage, "bin", "openarc"), `#!/bin/sh
# OpenArc ${version} standalone launcher: runs the package in ../lib/open-arc with the Node runtime next to this file.
self=$0
while [ -L "$self" ]; do l=$(readlink "$self"); case $l in /*) self=$l ;; *) self=$(dirname "$self")/$l ;; esac; done
here=$(cd "$(dirname "$self")/.." && pwd)
exec "$here/bin/node" --no-warnings "$here/lib/open-arc/dist/src/main.js" "$@"
`);
chmodSync(join(stage, "bin", "openarc"), 0o755);

const tgz = join(root, "build", `${name}.tar.gz`);
execFileSync("tar", ["-czf", tgz, "-C", join(root, "build", "binary"), name], { stdio: "inherit" });
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const unpacked = Number(execFileSync("du", ["-sk", stage], { encoding: "utf8" }).split("\t")[0]) * 1024;
console.log(`built ${tgz} (${mb(statSync(tgz).size)}, ${mb(unpacked)} unpacked, node ${process.versions.node}); unpacked tree: ${stage}`);
