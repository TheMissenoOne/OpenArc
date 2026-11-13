---
name: openarc-specs
description: Use in a project with an arc/ folder or .openarc/, when asked to understand, map, document or change its behaviour, or to decompile a codebase into OpenArc specs.
---

# OpenArc specs

A project is described at four levels, smallest first:
- `arc/concept.arc`: what the project is, its goals, non-goals and terms.
- `arc/architecture.arc`: the parts, the modules each holds, which part uses which.
- `arc/spec/<module>.arc`: one source module's types and functions, each with an intent and recorded calls.
- the code.

To learn what something does, run `openarc status` and read the module's `.arc` file before its source: it is much smaller. Read the source only for what the spec does not answer.

Run OpenArc as `.openarc/bin/openarc` (written by `openarc setup`), from the project directory that setup names. Never `npx openarc`.

## Decompiling a codebase

In this order:
1. `openarc decompile --run-tests`
2. `openarc arch`, then `openarc arch --check`
3. `openarc status`
4. `openarc decompile --todo` lists the functions with no intent. Fill them in batches by editing the `.arc` files directly: one or two plain sentences as `"..."` lines under the `fn` line, saying what it does and its edge cases, not how.

Hard rules for intents, to keep token use low:
- Read only the lines of the function you are describing. Find it with a line-numbered search (`grep -n "function name" src/file.js`), then read that range. Never read whole files.
- At most 15 functions per batch.
- Stop when the user's stated budget is reached, and report how many remain.
- Write nothing you did not read.

## Authority

- An `observed` line is what the code did, bugs included, not a requirement.
- Never change `observed` to `example`, and never write an `example`, unless the user confirmed that behaviour.
- Never edit a recorded value by hand.

## Parts and goals

- You may regroup `module` lines into better-named parts and write part intents in `arc/architecture.arc`.
- Write goals in `arc/concept.arc` only from what the user or the project's own docs say.
- After editing, run `openarc arch --check` and `openarc concept --check`.

## After changing code

Run `openarc decompile --check`. A `changed` line means behaviour changed with no spec change: report it. Do not paper over it by re-running `openarc decompile` unless the user accepts the change. A `failing` line is an `example` the code no longer satisfies.

## Changing behaviour from the spec

For a function in decompiled code (no markers), the `.arc` file leads:
1. Edit its intent, `example` lines or rules in `arc/spec/<module>.arc` (an `example` only as the user confirmed it).
2. `openarc arc status <module.fn>`: `stale` means an example fails; it shows what the code returns.
3. `openarc arc prompt <module.fn>` prints what to write. Read nothing else.
4. Write the body only (statements, no signature) and pipe it to `openarc arc accept <module.fn>`. It keeps the body only when every example holds; otherwise the file is unchanged and the failures are listed. Fix and retry at most twice.

Do not edit such a function's body by hand when its spec changed: use this loop.

## Compiling as the host agent

`openarc prompt <id>` prints what to write; pipe the body to `openarc accept <id>`, which checks and commits it. Never edit code between `// @openarc:begin` and `// @openarc:end` by hand: see the `openarc-sheet` skill.
