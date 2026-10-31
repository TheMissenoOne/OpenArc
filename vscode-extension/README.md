# OpenArc for VS Code

Editor support for OpenArc projects: navigation between specs and regions, ownership state at a glance, and marker diagnostics. It activates in any workspace that contains an `openarc.config.json`, including nested ones such as `selfhost/`.

## Features

- **Go to Definition.** Ctrl+Click (Cmd+Click on macOS) on the `id` string of a `defineRegion`/`defineBlock` call jumps to the region's `// @openarc:begin` marker. Ctrl+Click on the id of a begin or end marker jumps back to the spec. Specs and markers may be in different files of the same project.
- **CodeLens on specs:** the region state (`pending`, `compiler`, `developer`, `conflicted`), the number of examples (blocks show "verified via parent"), and for compiler-owned regions the model and attempt count from `.openarc/manifest.json`. Actions: **Go to implementation** and **Compile region** (`npx openarc compile <id>` in a terminal).
- **CodeLens on begin markers:** **Go to spec** and the state.
- **Diagnostics** (source `openarc`):
  - `OARC-E030` unmatched marker and `OARC-E031` crossed nesting, with the same stack pairing rules as the CLI;
  - `OARC-W001` for an `@openarc:` comment that is not a valid marker (block comment, shares its line with code, invalid id);
  - `OARC-E012` for a marker id that has no spec;
  - information for a spec with no markers: "run openarc scaffold".
- **Region tint:** a subtle whole-line background per state. The colors are theme colors you can override in `workbench.colorCustomizations`: `openarc.pendingBackground`, `openarc.compilerBackground`, `openarc.developerBackground`, `openarc.conflictedBackground`.
- **Commands** (Command Palette, category "OpenArc"), each running the CLI in the project root:
  - `OpenArc: Compile`: `npx openarc compile` in a terminal;
  - `OpenArc: Graph`: `npx openarc graph` into the "OpenArc" output channel;
  - `OpenArc: Release region` and `OpenArc: Freeze region`: they use the innermost region under the cursor, or ask for one.

State comes from the manifest, which is re-read whenever it changes. A region with no manifest entry is `pending` if its body is still the placeholder, and `developer` otherwise (SPEC-phase0 §6.2).

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
- `npm test`: builds, then runs `test/markers.check.mjs`, a plain Node check of the parsing module (`src/parse.ts`) against `selfhost/src/compile.ts`, `ids.ts` and `markers.ts`.

`typescript` is a runtime dependency because the parser runs inside the extension, so it ships in the `.vsix`.
