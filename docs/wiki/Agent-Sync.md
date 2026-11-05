# Agent Sync

Work from one editable file instead of a chat. `openarc.spec.md` lists every region's intent and examples. Edit it and save, and the code follows. Edit the code, and the file follows or offers suggestions. Claude Code, Codex and OpenCode only show what's happening: a save doesn't start an agent turn, so it spends none of your subscription.

```bash
npm i -D open-arc
npx openarc adopt            # a repo with no specs: generate them from the code
npx openarc sync --watch     # keep the file and the code in step
```

The sync engine is an ordinary command, so it also works with no agent at all.

## Adopting a repo with no specs

`openarc adopt` runs [[extract|Adopting Existing Code]] on every `src/**/*.ts`, leaving each body byte for byte and owned by you, then writes `openarc.spec.md`. A function that `extract` refuses, such as one with no declared return type, is listed with the reason.

Specs come from the code, and a model is the last resort:

| What | Where it comes from | Cost |
|---|---|---|
| Intent | The existing JSDoc | none |
| Examples | The body is run twice in the sandbox on inputs built from its parameter types. A throw or a result that differs between runs is dropped | none |
| Intent, when there's no JSDoc | The default backend, once per body | one request |
| Inputs, when the types can't produce them | The same request | none extra |

Examples go in `src/x.arc.ts` as `arc.configure` statements. Nothing imports that file, so your program gains no runtime dependency on OpenArc. With `--no-model`, nothing calls a model. These examples record what the code does today, so a bug gets recorded as expected behaviour. Read them.

## The file

```md
## text.slug
<!-- file: src/text.ts | owner: developer -->
`(title: string): string`

Lower-case words joined by dashes.

**Examples**
- ["Hello World"] -> "hello-world"
- ["  a  "] -> "a" # trims
```

| You do | What happens |
|---|---|
| Edit an intent or an example | It's written to the JSDoc, `arc.configure` or `defineRegion`, under the usual rules |
| Add `**Hold**` under a region | Spec edits still reach the code, but this body is never regenerated |
| Tick a suggestion | The spec changes to match the code. The body stays as it is |
| Add a section with `<!-- file: src/x.ts -->` and `` `name(a: T): R` `` | A new pending function, compiled like any other |
| Tick a function under `## Not adopted` | It's extracted |

The signature is read-only: change it in the code. Lines starting with `>` and comments are generated. A sheet with an unreadable line is reported and never applied or overwritten. TypeScript stays the source of truth, and a method's examples stay in `arc.test`. A deleted section comes back on the next sync: to remove a region, delete its code.

## Spec to code

A spec edit reaches the model only when it has to:

1. **Only examples changed and the body passes them:** the spec is recorded, with no model call.
2. **The intent changed, or the body fails:** the old body goes to `.openarc/backup/`, the region becomes compiler-owned, and it regenerates and has to pass its checks. If that fails, today's body stays and the file says so.
3. **No example and no `arc.test`:** the spec is recorded but the body isn't replaced, since nothing could check a new one. The file asks for an example.

Everything else `openarc compile` does still applies: stale regions, changed dependencies, a new model, callers re-checked, and a failed region remembered until something changes.

## Code to spec

A hand edit is caught by the usual ownership rules, then:

- **Its examples are re-run, with no model.** One that now returns something else becomes a suggestion: `- [ ] example: [1] -> 2`.
- **A big edit (8 changed lines by default) asks for a new intent,** from the local backend only. On a hosted backend you get a note instead, so a refactor never spends your subscription by itself.
- **JSDoc edited in the code** updates the file. If the same spec changed on both sides, the code's version is shown and the file says so.

## Tokens

The design keeps your subscription out of the loop:

- **A save costs no agent turn.** The agents' plugins add nothing to the system prompt and never send a prompt on their own.
- **Local first.** With the default config, nothing hosted is called.
- **Once per body.** A description is remembered by the body's hash.
- **Bounded fallback.** `sync.escalate` offers a stronger backend for a failed region, as a suggestion you tick. `sync.maxHostedTokensPerDay` stops hosted compiles at a limit.
- **On the record.** Every request goes in `.openarc/usage.jsonl`, and today's totals are in the status line.

### Using your subscription as a backend

```json
"backends": {
  "local": { "provider": "local", "baseUrl": "http://127.0.0.1:8080/v1", "model": "qwen3.5-9b", "maxContextTokens": 8192 },
  "claude": { "provider": "claude-cli", "model": "haiku", "maxContextTokens": 32768 }
},
"compilation": { "defaultBackend": "local" },
"sync": { "escalate": "claude", "maxHostedTokensPerDay": 50000 }
```

`claude-cli`, `codex-cli` and `opencode-cli` run that CLI with a fixed command line, no shell, no tools and an empty working directory. The command can't be set from the config file. Measured on one small request ("reply ok"), on 2026-11-05:

| Request | Input tokens |
|---|---|
| Plain `claude -p`, haiku, in an empty folder | about 31,700 |
| `claude-cli` backend | about 600 |
| `codex-cli` backend, its default model | about 13,900 (25,600 before its instructions were replaced) |
| `opencode-cli`'s setup, sent to a local model | about 130 |

Codex's remaining overhead couldn't be removed with the flags tried. These figures are one request each, and a real region adds its prompt on top: one small function through `claude-cli` took 1,132 input and 139 output tokens. The OpenCode figure comes from running its command by hand against a local model. Its hosted models weren't tested, because the key on the test machine had expired.

**Don't switch `defaultBackend` to a hosted backend to fix one region.** The backend is part of every fingerprint, so every compiler-owned region on the default recompiles. Use `sync.escalate`, or `regions.<id>.backend` for that one region.

## Agents

### Claude Code

```bash
claude --plugin-dir /path/to/OpenArc/integrations/claude-code
```

A pane beside the chat shows the watcher's status, what needs attention, and the compiler's log. The status line shows the totals.

| Command | Does |
|---|---|
| `/openarc` | Opens the pane |
| `/openarc-adopt` | Adopts the repo, then watches. No model turn |
| `/openarc-fix` | Puts only the items that need attention in your prompt box. Pressing Enter is what spends tokens |

The chat stays on screen: a plugin can't remove it, so this works beside it rather than replacing it.

### Codex

```bash
codex plugin marketplace add /path/to/OpenArc
codex plugin add openarc@openarc
```

This installs the skill and a hook that adds one status line at the start of a session. Codex has no pane API, so run `openarc sync --watch` in another terminal.

### OpenCode

Copy `integrations/opencode/openarc.ts` to `.opencode/plugin/`, and `skill/openarc-sheet/` to `.opencode/skill/openarc-sheet/`. The plugin runs the watcher for the life of the session.

All three share the `openarc-sheet` skill, which tells the agent to read the one-line status and single regions, never the whole file.

## Commands

| Command | Does |
|---|---|
| `openarc adopt [--no-model] [--brief] [--json]` | Generate specs for this repo. Creates `openarc.config.json` if there is none |
| `openarc sync [--no-model] [--brief] [--json]` | One pass. A repeat with nothing new writes nothing and calls nothing |
| `openarc sync --watch` | Keep syncing. One watcher per project, and it exits when the process that started it does |

`.openarc/sync-status.json` holds the last status.
