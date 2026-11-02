# OpenArc for VS Code

Editor support for OpenArc projects: navigation between specs and regions, ownership state at a glance, and marker diagnostics. It activates in any workspace that contains an `openarc.config.json`, including nested ones such as `selfhost/`.

## Features

- **Go to Definition.** Ctrl+Click (Cmd+Click on macOS) on the `id` string of a `defineRegion`/`defineBlock` call jumps to the region's `// @openarc:begin` marker. Ctrl+Click on the id of a begin or end marker jumps back to the spec. Specs and markers may be in different files of the same project.
- **CodeLens on specs:** the region state (`pending`, `compiler`, `developer`, `conflicted`, `stale`), the number of examples (blocks show "verified via parent"), and for compiler-owned regions the model and attempt count from `.openarc/manifest.json`; when the last compile failed, its code. Actions: **Go to implementation** and **Compile region** (`openarc compile <id>` in a terminal).
- **CodeLens on begin markers:** **Go to spec**, **Peek spec and attempts** and the state.
- **Peek** (`OpenArc: Peek spec, body and attempts`, or the CodeLens): one peek widget with the region's body, its spec, and its failed attempts from `.openarc/attempts/<id>/<n>.json`, newest first, each opened at its `body` line.
- **Live status** from `openarc watch`: a status bar item (the region compiling now, else the number failed or pending) and an **OpenArc** view in the Explorer with three groups: **Compiling** (from `.openarc/watch-history.jsonl`), **Pending** (pending or stale regions that have not failed since: what watch will compile; the watch keeps its queue in memory, so this is derived from the region states) and **Failed** (the last watch run of the region failed, or `.openarc/failed.json` lists it). Click a region to go to it; the inline eye icon peeks it. `OpenArc: Watch` starts `openarc watch` in its own terminal.
- **Diagnostics** (source `openarc`):
  - `OARC-E030` unmatched marker and `OARC-E031` crossed nesting, with the same stack pairing rules as the CLI;
  - `OARC-W001` for an `@openarc:` comment that is not a valid marker (block comment, shares its line with code, invalid id);
  - `OARC-E012` for a marker id that has no spec;
  - information for a spec with no markers: "run openarc scaffold";
  - on the begin marker of a region: `stale` (the spec changed since its body was verified), `OARC-W043` when it is stale and its last compile failed, and the code of that failure (`OARC-E098`, `OARC-W045`, `OARC-E090`, ...) from the watch history or `.openarc/failed.json`. A failure is shown only while the region is still pending or stale;
  - on the spec id: `OARC-W044` (thin examples) and the other `spec/*` findings of `openarc lint`.
- **Region tint:** a subtle whole-line background per state. The colors are theme colors you can override in `workbench.colorCustomizations`: `openarc.pendingBackground`, `openarc.compilerBackground`, `openarc.developerBackground`, `openarc.conflictedBackground`.
- **Commands** (Command Palette, category "OpenArc"), each running the CLI in the project root:
  - `OpenArc: Compile` and `OpenArc: Watch`: `openarc compile` / `openarc watch` in a terminal;
  - `OpenArc: Graph`, `OpenArc: Doctor`: into the "OpenArc" output channel;
  - `OpenArc: Release region`, `OpenArc: Freeze region`: they use the innermost region under the cursor, or ask for one;
  - `OpenArc: Check region against an oracle`: `openarc check <id> --oracle <module>#<export>`, asking for the oracle;
  - `OpenArc: Extract regions from this file`: `openarc extract <file> [--function <name>]` on the active file;
  - `OpenArc: Test backend`: `openarc backends test [name]` (sends one tiny request to the backend; asks which one when the config has several).
- **Setting `openarc.cliPath`:** the CLI to run, relative to the project root or absolute; a `.js`/`.mjs`/`.cjs`/`.ts` file runs with `node`. Empty (the default): `npx --no openarc`, the project's own install (`--no`: never downloads a package).

`stale`, the W044 findings and the other `spec/*` rules come from `openarc graph` and `openarc lint --format json`, both offline (no model, no sandbox). They run in the background after a save or a manifest change, debounced by 1.5 s, one process at a time; never on activation's critical path and never on a timer. The watch history, `failed.json` and the manifest are read on file-watcher events only. An older CLI without `lint` just shows no lint findings.

State comes from the manifest, which is re-read whenever it changes. Paths are compared case-insensitively on Windows, and the CLI runs through a shell there (npx is `npx.cmd`), with every argument validated first. A region with no manifest entry is `pending` if its body is still the placeholder, and `developer` otherwise (SPEC-phase0 §6.2).

Markers are found only in real comment tokens (via the TypeScript parser), so marker text inside strings, templates or regular expressions, as in spec examples, is ignored.

## Install locally

```sh
cd vscode-extension
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

This produces `openarc-vscode-0.1.0.vsix`. In VS Code, open the Extensions view, choose "..." then **Install from VSIX...**, and pick the file. Or run `code --install-extension openarc-vscode-0.1.0.vsix`.

## Development

- `npm run compile`: plain `tsc` build to `out/`.
- `npm test`: builds, then runs `test/markers.check.mjs`, a plain Node check of the parsing module (`src/parse.ts`) against `selfhost/src/compile.ts`, `ids.ts` and `markers.ts`, and `test/records.check.mjs` for the readers of the watch history, `graph` and `lint` output (`src/records.ts`).
- `npm run test:integration`: runs `test/integration/suite.cjs` inside a real VS Code (downloaded once into `.vscode-test/` by `@vscode/test-electron`) on a copy of `test/integration/fixture/`, with a fake CLI (`fake-openarc.mjs`) so no model is involved. It needs a display: on a headless Linux machine run `xvfb-run -a npm run test:integration`. `VSCODE_TEST_VERSION=1.85.2` tests the oldest supported VS Code.
- The "OpenArc" output channel logs the activation time (module loading plus the first indexing).

`typescript` is a runtime dependency because the parser runs inside the extension, so it ships in the `.vsix`.
