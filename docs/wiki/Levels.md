# Levels

A project is described at four levels. Each one is checked against the level below it wherever a machine can do it, so you can work in either direction: read code up into a concept, or write a concept and fill in what it needs down to code.

| Level | File | What it says | Checked against |
|---|---|---|---|
| Concept | `arc/concept.arc` | what the project is, its goals, its non-goals, a glossary | every goal names parts the architecture has |
| Architecture | `arc/architecture.arc` | the parts, which modules each holds, which part uses which, the third-party packages | the real import graph of the code |
| Spec | `arc/<module>.arc` | one module: types, functions, intents, examples. See [[Decompile]] | the code, by running the examples |
| Code | your source files | | |

```
openarc arch [dirs...] [--json]      derive arc/architecture.arc, or add to it
openarc arch [dirs...] --check [--json]
openarc concept [--json]             write a minimal arc/concept.arc, or reprint it in canonical form
openarc concept --check [--json]
```

`dirs` are the source directories (default `src`), the same files decompile reads: code files that are not tests.

## Architecture

```
architecture game
  "A survival game."

external three
  "3D rendering"
external node:fs

part sim
  "Deterministic simulation."
  module src/survival.js
  module src/worldos/**
  uses dsl
  uses three
```

| Line | Meaning |
|---|---|
| `architecture <name>` | the first line. Indented strings under it are the intent |
| `external <package>` | a third-party package: `three`, `@scope/pkg`, or `node:fs` for a Node built-in. A deep import such as `three/addons/x.js` belongs to `three`, and `fs` is read as `node:fs` |
| `part <name>` | a part of the project. Indented under it: intent strings, `module` and `uses` lines |
| `module <path>` | a source file, or `dir/**` for a directory and everything under it |
| `uses <name>` | another part or a declared external this part may import |

The first `openarc arch` makes one part per directory, named after its path with `/` as `.` (`src`, `src.sim`), and derives every `uses` and `external` line from the imports. Rename parts, merge them, write intents, replace file lists with a `dir/**` glob: a later run keeps all of it. It only adds:

- a source file in no part goes to the part that holds a file from the same directory, or else to a new part for its directory;
- a part it creates gets the `uses` and `external` lines its imports need.

It never removes a `uses`, and prints one line per addition.

`openarc arch --check` exits 1 on a violation:

- a source file in no part, or in more than one;
- a `module` line that matches no file;
- a file in part A imports a file in part B, and A has no `uses B`;
- a file imports a package its part does not `uses`, or that has no `external` line;
- a `uses` that names neither a part nor an external.

Warnings, exit 0: a `uses` no import needs, and parts that use each other in a cycle (each group of parts listed once). `--json` prints `{ "ok", "violations", "warnings" }`.

Imports are read with the TypeScript compiler's import scanner (static imports, re-exports, `require` and dynamic `import()`). A relative import is resolved to a source file as written, then with a code extension, then as `dir/index.*`; one that resolves to no source file (JSON, a test) is ignored. This is the one language-specific step: the file format and the checks know nothing about TypeScript.

## Concept

```
concept game
  "What the project is, in a few lines."

goal voice
  "The player talks to the daemon by voice."
  part daemon
  part audio

nongoal
  "Multiplayer."

term Daemon
  "The AI companion that carries out spoken intents."
```

| Line | Meaning |
|---|---|
| `concept <name>` | the first line. Indented strings under it say what the project is |
| `goal <name>` | something the project must do: intent strings and the `part` lines that carry it out |
| `nongoal` | something it deliberately does not do: intent strings |
| `term <word>` | a glossary entry: intent strings. The word may contain spaces |

With no file, `openarc concept` writes the header only and prints the architecture's parts, for a person or a coding agent to write goals against. With a file, it checks the syntax and reprints it in canonical form.

`openarc concept --check` exits 1 when a goal names no part, or names a part `arc/architecture.arc` does not have. It warns about a part no goal names and an empty concept intent.

## Limits

- The files live in `arc/`, whatever `--out` decompile used. A source module named `architecture` or `concept` at the top of a source directory would decompile to the same file name.
- Paths with spaces cannot be written in a `module` line.
- tsconfig `paths` aliases are read as packages.
- A cycle is reported per group of parts, not per elementary cycle inside the group.
