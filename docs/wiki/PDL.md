# PDL: the design language

A `.arc` file under `arc/features/` explains a part of a program the way a person would: what it is for, and only what a reader could not guess from that. It is pseudocode in C/JS shape (braces, semicolons, `name()` calls) where almost every statement is a free sentence. A coding agent writes code from it and writes it from code; OpenArc parses it, tracks whether each block and its code are still in step, and runs the few lines that are exact. OpenArc runs no model for any of this.

The smallest useful design is two sentences:

```
feature Slugs {
  turns a title into a URL slug: lower case, words joined by "-", nothing but a-z, 0-9 and "-";
  source "src/slug.js";
}
```

Everything else is optional and earns its place only when it says something the sentences cannot: a function block for one operation, an `example` that pins a result, `assume` for what every block would otherwise repeat, a `state`, `rule` or `screen` block when behaviour over time, an invariant or a page is the clearest way to say it. A design must stay much shorter than its code; OpenArc measures that.

This is a second language beside the strict module specs in `arc/spec/` ([[Writing Specs]], [[Arc Sync]]). Those keep working unchanged; nothing that reads `arc/spec` reads `arc/features`.

## A fuller example

```
// Checkout is the only path that charges a card; refunds live in billing.
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
    cart     -> reserved : confirm() when every line is in stock;
    reserved -> paid     : chargeOk() then email the receipt;
    reserved -> cart     : chargeFailed() then release();
    reserved -> cart     : after(15 min) then release();
    final paid;
  }

  rule noOversell() {
    stock never goes below zero;
    check all(s in stock, s.qty >= 0);
  }

  // The 15-minute hold is a promise in the terms of sale: do not shorten it.
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

`confirm` says nothing about reserving and charging: the state machine and the feature's purpose already say that. It keeps its signature, the one failure path that matters, and two examples. The state machine is here because this feature's behaviour over time is easiest to read that way; most features need none.

## Notes: what the code does not say

Comments are notes for whoever reads the design next, person or agent: the things no code and no example can state. A note belongs to a block when it is among the block's own items, or directly above its header (comment lines with no blank line between them and the header). Comments above the `feature` line and among the feature's own statements are the feature's notes.

Good notes:

- a reason: `// Retries are capped at 3 because the bank locks the card on the 5th failed attempt.`
- a constraint: `// Must answer within 200 ms: the checkout page blocks on it.` / `// Card numbers never reach our logs (PCI).`
- a non-goal: `// No multi-currency: every shop prices in one currency, by contract.`
- a plan: `// Coupons move to the pricing service in Q3; keep this thin until then.`
- who depends on it: `// The mobile app calls this with an old payload shape; keep accepting it.`

A note never restates behaviour an `example` could pin down. "Returns 0 for an empty cart" is an example (`example total([]) => 0;`), not a note.

Notes count as design: editing one makes its block `design ahead`, so the code (or whoever owns it) gets a chance to follow. Reformatting a note changes nothing. They are not counted in the design size (they say what code cannot, so comparing them with code size would be unfair); `pdl status --json` reports them apart as `noteSize`. `pdl show` prints a block's notes with the block, and the feature's notes in its `notes` section, so an agent working on one block always sees them. `pdl format` keeps every note with its block.

## Shape

A file is a sequence of blocks: `<header> { <items> }`. An item is a nested block or a statement. A statement is the text up to the next `;` that is not inside a string (`"..."`, with `\` escapes), parentheses, brackets or braces. `// ...` and `/* ... */` are comments, kept by every tool.

A `{` opens an object literal rather than a block when it follows `=>`, `=`, `:`, `,`, `(` or `[`, or when the statement starts with `example` or `check`. That is how `example f(x) => {total: 900};` stays one statement.

Every block kind except `feature` is optional:

| Block | Header | The question it answers | Id |
|---|---|---|---|
| feature | `feature Checkout` | what is this, and why | `Checkout` |
| assume | `assume` | what a reader may take for granted | `Checkout.assume` |
| state | `state Order` | how it behaves over time | `Checkout.Order` |
| rule | `rule noOversell()` (parentheses optional) | what must always hold | `Checkout.noOversell` |
| function | `confirm(cart: Cart, card: Card): Order`, `release()`, `Cart.add(n)` | what an operation does, in the order a person would explain it | `Checkout.confirm`, `Checkout.Cart.add` |
| screen | `screen CheckoutPage()` (parentheses optional) | what a person sees and does | `Checkout.CheckoutPage` |
| control | `if (...)`, `else`, `else if (...)`, `for each (...)`, `while (...)` | a branch or a loop inside a function; the condition is free text | none: part of its function |
| unknown | anything else | kept as it is | none |

A function's parameters are kept as text, with a best-effort split into `name: Type` pairs; both the parameters and the return type are optional. A function named `Class.method` is a method. Two blocks with the same id anywhere under `arc/features` are an error.

## Exact statement forms

Every statement that does not fit one of these exactly is a sentence.

| Form | Where | Meaning |
|---|---|---|
| `uses a, b;` / `uses external a, b;` | anywhere | other features this one relies on / outside systems |
| `source "path", "path";` | a feature, or any block in it | the code this block is about; a path ending in `/` is a directory |
| `example f(args) => value;` / `example f(args) throws "text";` | anywhere | a call and what it gives back; `example new Cart(10).add(3) => 3;` for a method; run by `pdl verify` |
| `check <expression>;` | anywhere | a property as an expression; run by `pdl verify` directly inside a function block |
| `fail "message";` | anywhere | the operation fails with that message |
| `initial a;` / `final a, b;` | `state` | the starting state / the states with no way out |
| `from -> to : trigger [when text] [then text];` | `state` | a transition; `when` and `then` are text, read as a call when shaped `name(...)`; `after(...)` is built in |
| `on event -> name(...);` | `screen` | what a user action does |
| `visible when Machine in (a, b);` | `screen` | when the screen shows, by the states of a machine in the same feature |

**Keyword or sentence.** A statement is an exact form only when the whole statement fits the pattern; one that merely starts with the keyword stays a sentence. Keywords are case-sensitive. Precisely:

- `uses` takes a comma list of single names (letters, digits, `_ $ @ . / -`): `uses of the coupon are counted;` is a sentence.
- `source` and `fail` take string literals only: `fail loudly when the card is refused;` is a sentence.
- `example` takes `name(...)` (or `new Name(...).name(...)`) and then `=> value` or `throws "text"`, nothing else: `example of a refund is a partial one;` is a sentence.
- `check` takes an expression with no two plain words in a row outside parentheses, brackets and strings; the rule operators `and`, `or`, `not`, `in`, `implies` are not plain words: `check total >= 0 and total <= 100;` is a check, `check the totals daily;` is a sentence.
- `initial`, `final` and transitions count only inside `state`; `on` and `visible when` only inside `screen`. `on` needs a `name(...)` target.

Comments and runs of whitespace inside a statement do not matter to which form it is.

## Verify: running the exact lines

`pdl verify` runs what can be run with no model, in the same sandbox and with the same comparison as `openarc decompile --check`, and says plainly what it could not run.

- **`example` lines in a function block.** The block's `source` (its own, else its feature's) must be exactly one file a language reads (TypeScript, JavaScript, Go), and the file must export the function under the block's name; a block named `Class.method` is a method, and its examples build a fresh receiver: `example new Cart(10).add(3) => 3;`. Arguments and values are literals in JS object-literal style: strings, numbers, booleans, `null`, arrays, objects with unquoted keys. An argument that is a bare name (`visa`, `emptyCart`) is no literal: that example is "not runnable", with the reason, never a failure. `throws "text"` passes when the error message contains the text.
- **`check` lines directly inside a function block** are rules in the rules language of `.arc` specs (src/rules.ts): the parameters by the names in the block's header, `result`, `threw`, `after.<p>`, `old.<p>`, `len`, `all`, `any`. A check runs on the examples' inputs and on inputs generated from them, and is reported as "held on N inputs" or "broken by (input)", never as proved. It needs at least one runnable example. A `check` in a `rule` block, a feature, or a branch inside a function has nothing bound to it: "not runnable".
- **Everything else** (sentences, transitions, `on`, `visible when`) is not run; verify counts it once as "not checked", so nobody mistakes silence for a pass.

`pdl status --json` and `pdl show --json` carry, per block, `exact: { runnable, notRunnable }`, counted from the text alone: no code runs for them.

## Keep it shorter than the code

A design is worth reading only when it is substantially shorter than the code it describes. OpenArc measures it: the design size of a block is its text without comments, in non-whitespace characters; the code size is the same count over the files its `source` names (comments included, whatever the language). `pdl status` shows the ratio for each feature and each block with its own `source` (any other block would be measured against its whole feature's code), and `pdl check` notes a block that has its own `source` and is over 50% of its code, and a feature whose whole design is over 50% of all its sources.

Rules of thumb:

- write what a reader could not assume;
- one sentence for a routine operation (`applyCoupon`, `release` above);
- steps only where the order or a failure path matters;
- never restate what a signature already makes obvious;
- move what every block would otherwise repeat into `assume`;
- pin a result with an `example`, explain a reason with a note.

## Tolerant

Nothing in a design is rejected for being unfamiliar. An unknown block is kept as it is; a statement that fits no form is a sentence. The parser never fails: it always returns a tree, and the only problems it reports are structural, each with its line:

- a `}` that closes nothing, or a block that is never closed;
- a string never closed on its line, or a `/*` comment never closed;
- a statement with no `;` before the `}` that follows it, or at the end of the file (it is kept as a sentence).

Every file round-trips byte for byte, broken ones included: each character of the input is kept in exactly one place in the tree, so printing the tree gives back the file.

## Statuses

`.openarc/pdl.json` holds, per block id, a hash of the block's design and a hash of its code at the last time they were declared in step (`pdl sync`). The design hash covers the block's text without comments and with whitespace normalised, plus its notes (whitespace normalised too), so reformatting is not a change; a block without notes hashes exactly as before notes counted. A feature's own hash covers its header, direct statements and notes, not its nested blocks. The code hash covers the files the block's `source` names: its own `source` statements, else its feature's. A directory is every file under it, recursively and in sorted order, skipping `node_modules`, `.git`, `.openarc`, `dist` and `build`.

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
openarc pdl verify [<feature>|<id>] [--json]
openarc pdl sync <ids...> | --all [--no-verify]
openarc pdl format [--check] [files...]
```

- **status**: a table grouped by feature, each block under its feature by its short name, then a totals line with the overall design/code percentage over the linked features:

  ```
  Checkout          in step       design 31% of code
    assume          in step
    Order           code ahead
    confirm         design ahead  design 22% of code
  4 blocks: new 0, in step 2, design ahead 1, code ahead 1, both changed 0, not linked 0; design 31% of code
  ```

  `--json` gives `{summary, blocks}`, each block with `designSize`, `noteSize`, `ownSource`, `exact`, and `codeSize` and `ratio` where its code is linked and not empty. A report: exit 0.
- **check**: structural problems and lint. Errors: a duplicate block id; more than one `initial`; a `final` state with an outgoing transition; a state unreachable from `initial` (when there is one); a `visible when` that names a machine the feature does not have, or a state the machine never mentions. Notes: a call in a trigger, a `then`/`when` or an `on` with no function block of that name in the feature (it may be covered by `assume`), and a design over 50% of its code. Exit 1 on any error, 0 with notes only.
- **show**: what an agent needs to translate one block and nothing more: the block's text dedented to column 0 with the notes right above it, then the sections that are not empty, each labelled the same way: `purpose` (the feature's sentences), `notes` (the feature's notes), `assume` (its statements), `uses`, `source`, `status` (with the exact-line counts). For a feature, the text is its header and own statements, its notes are the `notes` section, and its blocks are listed under `blocks`. Exit 1 for an unknown id.
- **verify**: one line per block with exact lines, the failed and not runnable lines indented under it with what the code returned or threw, or why the line could not run, then a totals line with the not-checked count. `--json` carries every line's outcome. Exit 1 when a line failed, 0 otherwise (not runnable is no failure). An invalid `openarc.config.json` stops it when something would run.
- **sync**: after an agent has made design and code agree, record both hashes for those blocks. Refused, exit 1 and nothing written, when `pdl check` has an error in a named block's file (in any file, for `--all`) or an id is unknown. Before recording a block, its runnable exact lines run as in `verify`: a block with a failing line is not recorded (its old entry stays), the message names the line, and the exit is 1; the other blocks are recorded. A block with nothing runnable syncs without running anything. `--no-verify` skips the run (for code that cannot run in the sandbox). Syncing a feature id records only the feature's own entry. `--all` records every block and drops blocks that are gone.
- **format**: rewrite to the canonical layout: two-space indent, one statement per line, a blank line around each non-control block, `} else {`, a `state` block's transitions aligned in columns (`initial` and `final` lines as they are), comments kept with their block (one on the same line as what precedes it stays there). It is idempotent and never changes a statement's tokens. A file with structural problems is left as it is and reported (exit 1). `--check` writes nothing and exits 1 naming the files that would change.

A typical loop for an agent: `pdl status` to see what moved, `pdl show <id>` for one block, edit the code or the design until they agree, `pdl verify <id>`, `pdl check`, then `pdl sync <id>`.

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

- Nothing verifies that a sentence is true of the code. "In step" means that someone declared the two in step, neither changed since, and the block's runnable exact lines held when it was synced.
- A `check` reads parameters by the names in the function block's header, typed `Any`: `x in Type` knows only the built-in types.
- No translation happens inside OpenArc: the host agent writes code from the design, or the design from code.
