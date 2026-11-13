---
name: openarc-design
description: Use in a project with an arc/features/ folder, when the user mentions a design, a feature file or a .arc design, or asks to change behaviour in a project that has design files. Keeps the design and the code in step, in both directions.
---

# OpenArc design files

A design file, `arc/features/<name>.arc`, explains part of the program the way a person would: what it is for, what a reader may take for granted, and what each operation does. It is pseudocode in C/JS shape where most statements are free sentences and a few forms are exact. Each block names its code with `source`; OpenArc tracks whether the two are still in step and runs no model: you do the translating.

The design is the place to look first. Run `openarc pdl show <id>` before opening any source file, then open only the files it lists under `source`.

## Design to code

1. `openarc pdl status` lists every block and its status. Work only on blocks that are not `in step`.
2. For each `design ahead` block: `openarc pdl show <id>`, change the code so it does what the block says, `openarc pdl verify <id>`, then `openarc pdl sync <id>`.
3. When a feature's own sentences or its `assume` block changed, review every block of that feature: they all rely on it.

## Code to design

After you change code, or when a block is `code ahead`, decide whether the change is visible at the level of the design.
- Not visible (a refactor, a rename inside, a faster loop): just `openarc pdl sync <id>`.
- Visible: edit the smallest part of the block that makes it true again, then `openarc pdl verify <id>` and `openarc pdl sync <id>`.
- `both changed`: read both. When they contradict each other, ask the user which is meant; never silently pick one.
- `new`: never synced. Check that design and code agree, then sync.

`pdl sync` refuses a block while `openarc pdl check` reports an error in its file, or while its runnable examples fail. `--no-verify` skips that second gate: use it only when the user says so.

## Starting on existing code

`openarc pdl draft <path>` writes a skeleton design from the code. Then fill in each feature's purpose, delete the blocks a reader would assume anyway, and ask the user for the notes only they can give: reasons, limits, plans.

## Writing a design

- Write what a reader could not assume.
- One sentence for a routine operation.
- Steps only where the order or a failure path matters.
- What the whole feature takes for granted goes once in `assume`.
- Never restate the signature.
- Keep the design well under half the size of its code: `pdl status` shows the percentage, `pdl check` notes anything above 50%.
- `state`, `rule`, `screen` and `assume` are all optional. A state machine is one way to describe behaviour; use it only when the thing really has states.
- After editing, run `openarc pdl check`; `openarc pdl format` fixes the layout.

## Exact forms

A line is exact only when all of it fits a form; anything else is a sentence. The forms: `uses a, b;`, `source "path";`, `fail "message";`, `example f(args) => value;`, `example f(args) throws "text";`, `check <expression>;`, and inside `state` / `screen`: `initial a;`, `final a;`, `from -> to : trigger() when ... then ...;`, `on event -> name();`, `visible when Machine in (a, b);`.

`example` and `check` are the only lines OpenArc runs (`pdl verify`). Add an `example` whenever a behaviour matters enough that it must not drift. Prefer literal arguments: `example total([{price: 450, qty: 2}]) => 900;` runs, `example total(cart) => 900;` names a value and cannot be run.

## Notes

`//` comments inside or directly above a block are the user's notes to you about what the code does not say: a reason, a limit, a plan. Read them as instructions about intent. Keep them when you rewrite a block, never delete a user's note, and do not turn behaviour into notes: behaviour belongs in statements.

## What not to claim

A sentence is never verified. Say "verified" only for the `example` and `check` lines that `openarc pdl verify` passed; for the rest, say the design and code were reviewed and synced.

## Beside other skills

This skill governs only the design files and the sync step. The project's own coding, testing and review skills still apply to the code. `arc/spec/` and the other OpenArc levels belong to the `openarc-specs` skill.

Run OpenArc as the wrapper `openarc setup` wrote (`.openarc/bin/openarc`), never `npx openarc`.
