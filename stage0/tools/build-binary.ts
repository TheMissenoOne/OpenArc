// Build the standalone download: build/openarc-<version>-<os>-<arch>.tar.gz (.zip on Windows), the npm package
// (tools/build.ts) next to the Node runtime running this script and a launcher, so a machine without Node or npm can run
// `openarc`. Layout: openarc-<v>-<os>-<arch>/bin/openarc (sh launcher) and bin/node, or on Windows bin\openarc.cmd and
// bin\node.exe; lib/open-arc/ (the package, with node_modules/typescript), LICENSE (OpenArc's), LICENSE.node (Node's).
// Not a Node single executable: on Node 25 a SEA loads only built-in modules, cannot act as the Node runtime the example
// sandbox spawns, and the harness and record.mjs must be files on disk; shipping node itself keeps every path the npm
// install takes (process.execPath is a real node) unchanged.
// Usage: node tools/build-binary.ts   (run from stage0/, with the Node version to ship)
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const win = process.platform === "win32";
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
cpSync(process.execPath, join(stage, "bin", win ? "node.exe" : "node"));
const nodeLicense = join(win ? dirname(process.execPath) : dirname(dirname(process.execPath)), "LICENSE"); // Windows: next to node.exe
if (existsSync(nodeLicense)) cpSync(nodeLicense, join(stage, "LICENSE.node"));
cpSync(join(root, "..", "LICENSE"), join(stage, "LICENSE"));
// The same flags the npm bin gets through its shebang, plus --no-warnings as setup's wrapper uses.
if (win) {
  writeFileSync(join(stage, "bin", "openarc.cmd"), `@echo off\r\nrem OpenArc ${version} standalone launcher: runs the package in ..\\lib\\open-arc with the Node runtime next to this file.\r\n"%~dp0node.exe" --no-warnings "%~dp0..\\lib\\open-arc\\dist\\src\\main.js" %*\r\n`);
} else {
  // follows symlinks to itself, so a link from ~/.local/bin works
  writeFileSync(join(stage, "bin", "openarc"), `#!/bin/sh
# OpenArc ${version} standalone launcher: runs the package in ../lib/open-arc with the Node runtime next to this file.
self=$0
while [ -L "$self" ]; do l=$(readlink "$self"); case $l in /*) self=$l ;; *) self=$(dirname "$self")/$l ;; esac; done
here=$(cd "$(dirname "$self")/.." && pwd)
exec "$here/bin/node" --no-warnings "$here/lib/open-arc/dist/src/main.js" "$@"
`);
  chmodSync(join(stage, "bin", "openarc"), 0o755);
}

// Windows: its own bsdtar (System32\tar.exe, Windows 10 and later) writes the zip; a tar earlier on PATH (Git's) cannot
const out = join(root, "build", `${name}${win ? ".zip" : ".tar.gz"}`);
const tar = win ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
execFileSync(tar, [win ? "-a" : "-z", "-cf", out, "-C", join(root, "build", "binary"), name], { stdio: "inherit" });
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const unpacked = readdirSync(stage, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0);
console.log(`built ${out} (${mb(statSync(out).size)}, ${mb(unpacked)} unpacked, node ${process.versions.node}); unpacked tree: ${stage}`);
