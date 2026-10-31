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

`init` creates `openarc.config.json`, `tsconfig.json` (strict, `erasableSyntaxOnly`) and `.openarc/`. At a terminal, or with `--example`, it also writes a code-first starter in an empty `src/` (`src/hello.ts` and `src/hello.test.ts`); `--no-example` skips it.

OpenArc projects are ES modules. Recent npm versions make `npm init -y` write `"type": "commonjs"`, and `tsc` then fails with `TS1295`; that is what `npm pkg set type=module` above fixes. If you skip it, `init` prints a one-line note telling you to run it. It never edits your `package.json` itself.

Plain `init` sets up local Ollama (`qwen3.5:9b`). To start with another backend instead, pass a preset, for example `npx openarc init --backend openrouter --model qwen/qwen3-coder` or `npx openarc init --backend local --model qwen3.5-9b --base-url http://127.0.0.1:8080/v1`. Then `npx openarc backends test` sends one small request and tells you whether the backend works, and why not if it doesn't. See "Connecting providers" in [[Configuration]].

## Your first region

`npx openarc init --example` (or plain `init` at a terminal) writes a starter: an interface and a class with one pending method, and its tests. Or write it yourself.

`src/hello.ts`:

```ts
import * as arc from "open-arc";

/** Greets people by name. */
export interface Greeter {
  /**
   * "Hello, <name>!" with the name trimmed of surrounding spaces;
   * "Hello, world!" when the name is empty or only spaces.
   */
  greet(name: string): string;
}

export class FriendlyGreeter implements Greeter {
  greet(name: string): string {
    return arc.todo();
  }
}
```

`src/hello.test.ts`:

```ts
import * as arc from "open-arc";
import { FriendlyGreeter } from "./hello.ts";

arc.test(FriendlyGreeter, "greets by name", (G, expect) => {
  const g = new G();
  expect(g.greet("Ada")).toBe("Hello, Ada!");
  expect(g.greet("  Bob ")).toBe("Hello, Bob!");
});

arc.test(FriendlyGreeter, "an empty name greets the world", (G, expect) => {
  expect(new G().greet("")).toBe("Hello, world!");
  expect(new G().greet("   ")).toBe("Hello, world!");
});
```

The body `return arc.todo();` makes `FriendlyGreeter.greet` a region, `hello.friendlyGreeter.greet`. Its signature is the contract, the interface's JSDoc is its intent (an undocumented member inherits it), and the tests are TypeScript: a wrong test, such as `g.greet(42)` or `toBe(1)`, is a type error in your editor before OpenArc ever runs.

```bash
npx tsc -p .           # pending bodies and tests type-check as written
npx openarc graph      # hello.friendlyGreeter.greet  F pending  0 ex 2 tests  src/hello.ts
npx openarc compile
```

The log looks like this (illustrative: the timings and sizes depend on the model and machine):

```
  hello.friendlyGreeter.greet: attempt 1 via local (qwen3.5:9b), context L0 2012 chars, 1.4s
  hello.friendlyGreeter.greet: ✓ tsc, static, tests:2/2
done: exit 0 · 1 model call(s) · 2.3s
```

The model saw the class, the interface with its JSDoc, and the two tests. The body it returned type-checked and passed both tests in the sandbox, so OpenArc wrote it in. When an attempt fails, the next one gets the failing assertions (`line 6: expect(g.greet("  Bob ")).toBe("Hello, Bob!") / got "Hello,   Bob !"; expected "Hello, Bob!"`).

## What you get

```ts
export class FriendlyGreeter implements Greeter {
  greet(name: string): string {
    // @openarc:begin hello.friendlyGreeter.greet
    const n = name.trim();
    return `Hello, ${n || "world"}!`;
    // @openarc:end hello.friendlyGreeter.greet
  }
}
```

It's ordinary TypeScript: edit it, Ctrl+Click it, commit it. The markers inside the body are the region's identity from now on, so you can rename the class or move the file. Run `compile` again and it makes **0 model calls**, because nothing changed. If you edit the body by hand, OpenArc reports `OARC-W060` and never touches the region again until you run `openarc release hello.friendlyGreeter.greet`.

Next: [[Code First]] for classes, hidden tests, laws and fakes; [[Writing Specs]] for `defineRegion`, blocks, sketches, concepts and UI specs, which all keep working.

## The `defineRegion` form

The same region written as a spec, which OpenArc has supported since 0.1 and still does:

```ts
import * as arc from "open-arc";

type Greet = (name: string) => string;

export const greetSpec = arc.defineRegion<Greet>({
  id: "hello.greet",
  intent: "\"Hello, <name>!\" with the name trimmed; \"Hello, world!\" when it is empty or only spaces.",
  examples: [
    { args: ["Ada"], expected: "Hello, Ada!" },
    { args: ["  Bob "], expected: "Hello, Bob!" },
    { args: [""], expected: "Hello, world!" },
  ],
});
```

`npx openarc scaffold` then adds `export const greet: Greet = (name) => arc.todo("hello.greet");` between markers (no model involved), and `compile` replaces it. A wrong example, such as `expected: 42`, is a type error too.
