// DEPRECATED and frozen since 0.9.0, like the bundled palette it copies: it keeps working, with no behaviour changes.
// The palette's compilable copy: every region body back to its pending placeholder, everything else byte for byte.
// stage0/src/palette holds the hand-written bodies (the way stage0 works); selfhost/src/palette and
// examples/palette-demo/src/palette hold this copy, for OpenArc to compile.
// Usage (from an OpenArc checkout): node stage0/tools/palette.ts <project dir> [--force]
//   writes <dir>/src/palette/* (pending) and <dir>/tests/fakes/palette.*. It stops before writing anything when one of
//   those files exists (your edits would be lost); --force overwrites them.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Replace each `// @openarc:begin <id>` … `// @openarc:end <id>` body with `export const s: T = (params) => arc.todo("<id>");`. */
export function pendingCopy(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^([ \t]*)\/\/ @openarc:begin (\S+)\n([\s\S]*?)\n[ \t]*\/\/ @openarc:end \2$/gm, (_m, ind: string, id: string, body: string) => {
    const head = /^\s*(export )?const (\w+): (.+?) = (?:async )?\(([^)]*)\) =>/m.exec(body);
    if (!head) throw new Error(`palette: can't read the declaration of ${id}`);
    return `${ind}// @openarc:begin ${id}\n${ind}${head[1] ?? ""}const ${head[2]}: ${head[3]} = (${head[4]}) => arc.todo("${id}");\n${ind}// @openarc:end ${id}`;
  });
}

const here = fileURLToPath(new URL("..", import.meta.url)); // stage0/
export const PALETTE_FILES = readdirSync(join(here, "src/palette")).filter((f) => /\.tsx?$/.test(f)).sort();
export const PALETTE_FAKES = readdirSync(join(here, "tests/fakes")).filter((f) => f.startsWith("palette.")).sort();

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.error("palette: deprecated: the bundled palette is frozen since 0.9.0; write your own concepts (docs/wiki/Palette.md, Building your own palette)");
  const force = process.argv.includes("--force");
  const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!dir) throw new Error("usage: node tools/palette.ts <project dir> [--force]");
  const targets = [...PALETTE_FILES, "README.md"].map((f) => join(dir, "src/palette", f)).concat(PALETTE_FAKES.map((f) => join(dir, "tests/fakes", f)));
  const existing = targets.filter((t) => existsSync(t));
  if (existing.length && !force) {
    console.error(`palette: ${existing.length} file(s) exist and would be overwritten (rerun with --force to replace them):\n${existing.map((t) => `  ${t}`).join("\n")}`);
    process.exit(1);
  }
  mkdirSync(join(dir, "src/palette"), { recursive: true });
  mkdirSync(join(dir, "tests/fakes"), { recursive: true });
  for (const f of PALETTE_FILES) writeFileSync(join(dir, "src/palette", f), pendingCopy(readFileSync(join(here, "src/palette", f), "utf8")));
  copyFileSync(join(here, "src/palette/README.md"), join(dir, "src/palette/README.md"));
  for (const f of PALETTE_FAKES) copyFileSync(join(here, "tests/fakes", f), join(dir, "tests/fakes", f));
  console.log(`palette: ${PALETTE_FILES.length} files (pending bodies) and ${PALETTE_FAKES.length} fakes -> ${dir}`);
}
