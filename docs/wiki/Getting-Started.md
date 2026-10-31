# Getting Started

## Requirements

| | |
|---|---|
| OS | Linux with `bwrap` (bubblewrap) and `prlimit` (util-linux) |
| Node | ≥ 23.6 (runs `.ts` directly) |
| Models | [Ollama](https://ollama.com), e.g. `ollama pull qwen3.5:9b` |

Examples always run in a sandbox. If `bwrap` is missing, OpenArc refuses to run them; it never falls back to unsandboxed execution.

## Install

```bash
mkdir my-app && cd my-app && npm init -y && npm pkg set type=module
npm i -D @openarc/core
npx openarc init
```

`init` creates `openarc.config.json`, `tsconfig.json` (strict, `erasableSyntaxOnly`) and `.openarc/`.

## Your first region

`src/tasks.ts`:

```ts
import * as arc from "@openarc/core";

type NormalizeTitle = (title: string) => string;

export const normalizeTitleSpec = arc.defineRegion<NormalizeTitle>({
  id: "tasks.normalizeTitle",
  intent: "Trim, collapse internal whitespace to one space, capitalize the first letter.",
  examples: [
    { args: ["  buy   milk "], expected: "Buy milk" },
    { args: ["x"], expected: "X" },
    { args: ["   "], expected: "" },
  ],
});
```

A wrong example, such as `expected: 42`, is a type error in your editor before OpenArc ever runs.

```bash
npx openarc scaffold   # adds markers + a typed placeholder (no model involved)
npx tsc -p .           # optional: after scaffold, so imports of other files' regions resolve
npx openarc compile
```

Real output (qwen3.5:9b on an RX 7600):

```
  tasks.normalizeTitle: attempt 1 via local (qwen3.5:9b), context L0 973 chars, 1.1s
  tasks.normalizeTitle: ✗ OARC-E070 TS2304 line 17: Cannot find name 'rest'.
  tasks.normalizeTitle: attempt 2 via local (qwen3.5:9b), context L1 1037 chars, 1.9s
  tasks.normalizeTitle: ✓ tsc, static, examples:3/3
done: exit 0 · 2 model call(s) · 3.5s
```

The first attempt failed type-checking. A missing name counts as a context problem, so attempt 2 got a larger context package (L1) plus the error, and passed.

## What you get

```ts
// @openarc:begin tasks.normalizeTitle
export const normalizeTitle: NormalizeTitle = (title) => {
  return title.trim().replace(/\s+/g, ' ').charAt(0).toUpperCase() + title.trim().replace(/\s+/g, ' ').slice(1);
};
// @openarc:end tasks.normalizeTitle
```

It's ordinary TypeScript: edit it, Ctrl+Click it, commit it. Run `compile` again and it makes **0 model calls**, because nothing changed. If you edit the body by hand, OpenArc reports `OARC-W060` and never touches the region again until you run `openarc release tasks.normalizeTitle`.
