// Build the publishable `open-arc` npm package into build/ (compiled JS, d.ts, bin `openarc`).
// Node refuses to strip types under node_modules, so the published package must be JS.
// Usage: node tools/build.ts   then   cd build && npm pack
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const root = process.cwd();
const version = JSON.parse(readFileSync(`${root}/core/package.json`, "utf8")).version as string;
rmSync(`${root}/build/dist`, { recursive: true, force: true }); // keep earlier *.tgz: other checkouts install them by path
execFileSync(`${root}/node_modules/.bin/tsc`, ["-p", "tsconfig.build.json"], { stdio: "inherit" });
const tsVersion = JSON.parse(readFileSync(`${root}/node_modules/typescript/package.json`, "utf8")).version as string;
writeFileSync(`${root}/build/package.json`, JSON.stringify({
  name: "open-arc",
  version,
  description: "Compile typed specs into verified TypeScript with small local models: per-function context, sandboxed examples, never overwrites your edits.",
  type: "module",
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/TheMissenoOne/OpenArc.git" },
  homepage: "https://github.com/TheMissenoOne/OpenArc/wiki",
  bugs: "https://github.com/TheMissenoOne/OpenArc/issues",
  keywords: ["llm", "compiler", "typescript", "codegen", "ollama", "local-llm", "spec", "verification"],
  bin: { openarc: "dist/src/main.js" },
  exports: {
    ".": { types: "./dist/core/index.d.ts", default: "./dist/core/index.js" },
    "./harness": { types: "./dist/core/harness.d.ts", default: "./dist/core/harness.js" },
  },
  files: ["dist", "README.md"],
  engines: { node: ">=23.6" },
  os: ["linux"],
  dependencies: { typescript: `^${tsVersion}` },
  publishConfig: { access: "public" },
}, null, 2) + "\n");
chmodSync(`${root}/build/dist/src/main.js`, 0o755);
for (const f of ["README.md"]) if (existsSync(`${root}/${f}`)) cpSync(`${root}/${f}`, `${root}/build/${f}`);
console.log(`built open-arc@${version} -> build/`);
