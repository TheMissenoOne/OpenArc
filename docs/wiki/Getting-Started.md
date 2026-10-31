# Getting Started

## Requirements

| | |
|---|---|
| OS | Linux, macOS or Windows (since 0.7.0) |
| Node | ≥ 23.6 (runs `.ts` directly); Node 25+ recommended, see below |
| Models | [Ollama](https://ollama.com), e.g. `ollama pull qwen3.5:9b` |

Examples always run in a sandbox. How strong it is depends on the OS (`sandbox.isolation` in [[Configuration]]):

| OS | Default tier (`"auto"`) | What isolates generated code |
|---|---|---|
| Linux | `bwrap` (needs `bwrap` and `prlimit`) | bubblewrap namespaces (no network, read-only stage, private `/tmp`, no host processes), `prlimit` CPU and address-space caps, Node's permission model, heap cap |
| macOS | `sandbox-exec` | a `sandbox-exec` profile (no network, no writes outside the temp dir, no reads under your home except the stage, `node_modules` and Node), Node's permission model, heap cap, wall-clock timeout |
| Windows, or Linux without a usable `bwrap` | `node` (warns `OARC-W046`) | Node's permission model only: reads limited to the stage and `node_modules`; no writes, child processes, workers, addons or (Node 25+) network; heap cap, wall-clock timeout |
| any, opt-in | `container` | `podman`/`docker run --rm --network=none`, the stage mounted read-only, plus Node's permission model |
| any, opt-in | `unsafe-none` | nothing. Printed as an error (`OARC-W047`) on every run |

On Linux, install bubblewrap for the strong tier (`sudo apt-get install bubblewrap`, `sudo dnf install bubblewrap`). Ubuntu 24.04 restricts unprivileged user namespaces, which leaves `bwrap` installed but unusable; OpenArc notices and falls back to `node` with `OARC-W046`. The `node` tier blocks network access only on Node 25 and later: on Node 23.6 to 24, generated code in that tier can reach the network.

`npx openarc doctor` shows which tier this machine uses and runs one example in it that also tries to write a file, start a process and open a network connection. Run it once after installing. OpenArc never runs examples unsandboxed unless you write `"isolation": "unsafe-none"` yourself.

## Install

The package is [`open-arc` on npm](https://www.npmjs.com/package/open-arc); the command it installs is `openarc`.

```bash
mkdir my-app && cd my-app && npm init -y && npm pkg set type=module
npm i -D open-arc
npx openarc init
```

`init` creates `openarc.config.json`, `tsconfig.json` (strict, `erasableSyntaxOnly`) and `.openarc/`.

OpenArc projects are ES modules. Recent npm versions make `npm init -y` write `"type": "commonjs"`, and `tsc` then fails with `TS1295`; that is what `npm pkg set type=module` above fixes. If you skip it, `init` prints a one-line note telling you to run it. It never edits your `package.json` itself.

Plain `init` sets up local Ollama (`qwen3.5:9b`). To start with another backend instead, pass a preset, for example `npx openarc init --backend openrouter --model qwen/qwen3-coder` or `npx openarc init --backend local --model qwen3.5-9b --base-url http://127.0.0.1:8080/v1`. Then `npx openarc backends test` sends one small request and tells you whether the backend works, and why not if it doesn't. See "Connecting providers" in [[Configuration]].

## Your first region

`src/tasks.ts`:

```ts
import * as arc from "open-arc";

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
