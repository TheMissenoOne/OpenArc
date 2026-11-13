# PDL: the design language

A `.arc` file under `arc/features/` describes a part of a program the way a person would explain it: what it is for, what a reader may take for granted, how it behaves over time, what must always hold, and what each operation does. It is pseudocode in C/JS shape (braces, semicolons, `name()` calls) where most statements are free sentences and a few statement forms are exact. A coding agent translates in both directions, design to code and code to design; OpenArc parses the files, checks their structure, and tracks whether each block and its code are still in step. OpenArc runs no model for any of this.

This is a second language beside the strict module specs in `arc/spec/` ([[Writing Specs]], [[Arc Sync]]). Those keep working unchanged; nothing that reads `arc/spec` reads `arc/features`.

## The reference file

```
feature Checkout {
  a customer turns a cart into a paid order;
  the shop never charges for stock it does not have;

  source "src/checkout/", "src/pricing.js";
  uses inventory, pricing, payments;
  uses external stripe, postgres;

  assume {
    money is whole cents, never a float;
    Order has the usual create, read and list-by-customer operations;
  }

  state Order {
    initial cart;
    cart -> reserved : confirm() when every line is in stock;
    reserved -> paid : chargeOk() then email the receipt;
    reserved -> cart : chargeFailed() then release();
    reserved -> cart : after(15 min) then release();
    final paid;
  }

  rule noOversell() {
    stock never goes below zero;
    check all(s in stock, s.qty >= 0);
  }

  confirm(cart: Cart, card: Card): Order {
    source "src/checkout/confirm.js";
    if (a line cannot be reserved) {
      release the ones already reserved;
      fail "out of stock";
    }
    example confirm({lines: [{sku: "tea", qty: 2, price: 450}]}, visa) => {state: "paid", total: 900};
    example confirm(emptyCart, visa) throws "cart is empty";
  }

  applyCoupon() {
    the usual percentage coupon;
    one per order, never below zero, expired ones are refused;
  }

  release() { give the reserved units back; }

  screen CheckoutPage() {
    show the lines, the total, a coupon field and a Pay button;
    on pay.click -> confirm();
    on coupon.apply -> applyCoupon();
    visible when Order in (cart, reserved);
  }
}
```

`confirm` says nothing about reserving and charging: the state machine and the feature's purpose already say that. It keeps its signature, the one failure path that matters, and two examples.

## Shape

A file is a sequence of blocks: `<header> { <items> }`. An item is a nested block or a statement. A statement is the text up to the next `;` that is not inside a string (`"..."`, with `\` escapes), parentheses, brackets or braces. `// ...` and `/* ... */` are comments, kept by every tool.

A `{` opens an object literal rather than a block when it follows `=>`, `=`, `:`, `,`, `(` or `[`, or when the statement starts with `example` or `check`. That is how `example f(x) => {total: 900};` stays one statement.

| Block | Header | The question it answers | Id |
|---|---|---|---|
| feature | `feature Checkout` | what is this, and why | `Checkout` |
| assume | `assume` | what a reader may take for granted | `Checkout.assume` |
| state | `state Order` | how it behaves over time | `Checkout.Order` |
| rule | `rule noOversell()` (parentheses optional) | what must always hold | `Checkout.noOversell` |
| function | `confirm(cart: Cart, card: Card): Order`, `release()` | what an operation does, in the order a person would explain it | `Checkout.confirm` |
| screen | `screen CheckoutPage()` (parentheses optional) | what a person sees and does | `Checkout.CheckoutPage` |
| control | `if (...)`, `else`, `else if (...)`, `for each (...)`, `while (...)` | a branch or a loop inside a function; the condition is free text | none: part of its function |
| unknown | anything else | kept as it is | none |

A function's parameters are kept as text, with a best-effort split into `name: Type` pairs; both the parameters and the return type are optional. Two blocks with the same id anywhere under `arc/features` are an error.

## Exact statement forms

Every statement that does not fit one of these exactly is a sentence.

| Form | Where | Meaning |
|---|---|---|
| `uses a, b;` / `uses external a, b;` | anywhere | other features this one relies on / outside systems |
| `source "path", "path";` | a feature, or any block in it | the code this block is about; a path ending in `/` is a directory |
| `example f(args) => value;` / `example f(args) throws "text";` | anywhere | a call and what it gives back, kept as text |
| `check <expression>;` | anywhere | a property as an expression, kept as text |
| `fail "message";` | anywhere | the operation fails with that message |
| `initial a;` / `final a, b;` | `state` | the starting state / the states with no way out |
| `from -> to : trigger [when text] [then text];` | `state` | a transition; `when` and `then` are text, read as a call when shaped `name(...)`; `after(...)` is built in |
| `on event -> name(...);` | `screen` | what a user action does |
| `visible when Machine in (a, b);` | `screen` | when the screen shows, by the states of a machine in the same feature |

**Keyword or sentence.** A statement is an exact form only when the whole statement fits the pattern; one that merely starts with the keyword stays a sentence. Keywords are case-sensitive. Precisely:

- `uses` takes a comma list of single names (letters, digits, `_ $ @ . / -`): `uses of the coupon are counted;` is a sentence.
- `source` and `fail` take string literals only: `fail loudly when the card is refused;` is a sentence.
- `example` takes `name(...)` and then `=> value` or `throws "text"`, nothing else: `example of a refund is a partial one;` is a sentence.
- `check` takes an expression with no two plain words in a row outside parentheses, brackets and strings: `check total == sum(lines);` is a check, `check the totals daily;` is a sentence.
- `initial`, `final` and transitions count only inside `state`; `on` and `visible when` only inside `screen`. `on` needs a `name(...)` target.

Comments and runs of whitespace inside a statement do not matter to which form it is.

## Tolerant

Nothing in a design is rejected for being unfamiliar. An unknown block is kept as it is; a statement that fits no form is a sentence. The parser never fails: it always returns a tree, and the only problems it reports are structural, each with its line:

- a `}` that closes nothing, or a block that is never closed;
- a string never closed on its line, or a `/*` comment never closed;
- a statement with no `;` before the `}` that follows it, or at the end of the file (it is kept as a sentence).

Every file round-trips byte for byte, broken ones included: each character of the input is kept in exactly one place in the tree, so printing the tree gives back the file.

## Keep it shorter than the code

A design is worth reading only when it is substantially shorter than the code it describes. OpenArc measures it: the design size of a block is its text without comments, in non-whitespace characters; the code size is the same count over the files its `source` names (comments included, whatever the language). `pdl status` shows the ratio as a percentage, and `pdl check` notes a block that has its own `source` and is over 50% of its code, and a feature whose whole design is over 50% of all its sources.

Rules of thumb:

- write what a reader could not assume;
- one sentence for a routine operation (`applyCoupon`, `release` above);
- steps only where the order or a failure path matters;
- never restate what a signature already makes obvious;
- move what every block would otherwise repeat into `assume`.

## Statuses

`.openarc/pdl.json` holds, per block id, a hash of the block's design and a hash of its code at the last time they were declared in step (`pdl sync`). The design hash ignores comments and whitespace, so reformatting is not a change; a feature's own hash covers its header and direct statements, not its nested blocks. The code hash covers the files the block's `source` names: its own `source` statements, else its feature's. A directory is every file under it, recursively and in sorted order, skipping `node_modules`, `.git`, `.openarc`, `dist` and `build`.

| Status | Meaning |
|---|---|
| `new` | never synced |
| `in step` | neither side changed since the last sync |
| `design ahead` | the design changed: the code should follow |
| `code ahead` | the code changed: the design may need to follow |
| `both changed` | both changed: reconcile them |

Beside the status: `not linked` when no `source` covers the block (only the design is tracked), and `missing <path>` when a `source` path does not exist.

## Commands

```
openarc pdl status [<feature>|<id>] [--json]
openarc pdl check [--json]
openarc pdl show <id> [--json]
openarc pdl sync <ids...> | --all
openarc pdl format [--check] [files...]
```

- **status**: one line per block (`Checkout.confirm: design ahead, design 12% of code`) and a totals line with the overall design/code percentage over the linked features. `--json` gives `{summary, blocks}`, each block with `designSize`, and `codeSize` and `ratio` where its code is linked and not empty. A report: exit 0.
- **check**: structural problems and lint. Errors: a duplicate block id; more than one `initial`; a `final` state with an outgoing transition; a state unreachable from `initial` (when there is one); a `visible when` that names a machine the feature does not have, or a state the machine never mentions. Notes: a call in a trigger, a `then`/`when` or an `on` with no function block of that name in the feature (it may be covered by `assume`), and a design over 50% of its code. Exit 1 on any error, 0 with notes only.
- **show**: what an agent needs to translate one block and nothing more: the block's text, its feature's purpose sentences, the feature's `assume` block, `uses`, the resolved source paths, the status and sizes. For a feature, the text is its own (header and direct statements) and its blocks are listed by id. Exit 1 for an unknown id.
- **sync**: after an agent has made design and code agree, record both hashes for those blocks. Refused, exit 1 and nothing written, when `pdl check` has an error in a named block's file (in any file, for `--all`) or an id is unknown. Syncing a feature id records only the feature's own entry. `--all` records every block and drops blocks that are gone.
- **format**: rewrite to the canonical layout: two-space indent, one statement per line, a blank line around each non-control block, `} else {`, comments kept (one on the same line as what precedes it stays there). It is idempotent and never changes a statement's tokens. A file with structural problems is left as it is and reported (exit 1). `--check` writes nothing and exits 1 naming the files that would change.

A typical loop for an agent: `pdl status` to see what moved, `pdl show <id>` for one block, edit the code or the design until they agree, `pdl check`, then `pdl sync <id>`.

[[Setup]] installs the `openarc-design` skill for Claude Code, Codex and OpenCode, which teaches an agent this loop in both directions and the rules for writing a design. The [[MCP]] server has `pdl_status`, `pdl_show`, `pdl_check` and `pdl_sync`.

## Starting from existing code

```
openarc pdl draft <file-or-dir>... [--name <Name>] [--json]
```

`pdl draft` writes the first design file for code that already exists, with no model: a skeleton that an agent or a person then fills in and prunes. Each argument becomes one feature, named in PascalCase after the file (without its extension) or the directory (`--name` sets it, for a single argument), and written to `arc/features/<kebab-name>.arc`. When that file exists, or a design file already holds a feature of that name, nothing is written and the command exits 1, naming the file.

What the skeleton holds, in this order:

- a comment above the feature asking for what the code does not say (why it exists, its limits, plans). Comments are where people write natural language for the agent;
- one purpose sentence, the first sentence of the file's or package's doc comment, else the placeholder `describe what this is for;`;
- `source "<path>";` (a directory ends in `/`);
- for each file a language adapter reads (TypeScript, JavaScript, Go), one function block per exported function and public method of an exported class (`Class.method`, id `Feature.Class.method`), in source order, with its parameters, the types the adapter knows (not `Any`, not long ones) and the return type. The body is the first sentence of the doc comment, or empty (`{}`). When the feature covers more than one file, each block has its own `source` line, so its status follows only that file;
- for each file no adapter reads, one comment: `// <path>: no reader for this language yet; describe its operations here.`

A directory skips test files, `node_modules`, `.git`, `.openarc`, `dist`, `build`, `arc`, dot-files, and files that are not code (docs, data, styles). A file named on the command line is always drafted, unless it is a test file. A doc sentence becomes a valid sentence statement: `;` turns into `,`, braces into parentheses, and when that still does not parse as one plain sentence, quotes, brackets and comment openers are dropped; a sentence that would read as an exact form (`uses cache`) is left out.

The draft never invents `state`, `rule`, `screen` or `assume` blocks: those are design choices for whoever fills it in. It passes `pdl check`, is already in `pdl format` layout, and every block starts as `new` in `pdl status`. The command prints the file, the number of function blocks and the design size as a percentage of the code (`--json`: `{drafted: [{file, feature, functions, ratio}], next}`). Then: fill the purpose, delete the blocks a reader would assume, add notes, and `pdl sync` once design and code agree.

## Not in this slice

- Nothing evaluates `check` or `example` yet: they are kept as text.
- Nothing verifies that a sentence is true of the code. "In step" means only that someone declared the two in step and neither changed since.
- No translation happens inside OpenArc: the host agent writes code from the design, or the design from code.
