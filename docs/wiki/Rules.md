# Rules

A `rule` line in an `.arc` file states a property every call of the function must have. `openarc decompile --check` evaluates it on every call it makes: the `example` and `observed` lines, plus generated inputs. A rule is a property check, not a proof: a pass means it held on the inputs tried, and the report says exactly that (`held on 37 inputs`).

```
fn clampPct(n: Num): Num
  example (50) => 50
  example (150) => 100
  rule bounded: result in 0..100
```

```
src/pct.js: clampPct: rule bounded: broken by (-50) -> -50
```

No written example passes a negative number; a generated one did.

## Grammar

```
rule <name>: <expr>

expr     = a implies b                 right to left; b is not evaluated when a is false
         | a or b | a and b | not a
         | a == b | a != b             deep structural equality (numbers within 1e-9 relative)
         | a < b | a <= b | a > b | a >= b       two numbers or two strings
         | x in lo..hi                 a number between lo and hi, both included
         | x in <type>                 the value fits an .arc type: Int, Float, Num, Bool, Str, Any, Void, Null,
                                       [T], { k: T, k?: T }, A | B, T?, literals, `native`, a `type` name
         | a + b | a - b | a * b | a / b | a % b | -a      numbers; + also joins two strings
         | a.field | a[index]          index: a list or string position (negative counts from the end), or a key
         | len(x)                      length of a string or list
         | all(xs, x => expr) | any(xs, x => expr)
         | ( expr ) | 12 | 1.5 | "text" | true | false | null | name

names    = each parameter (its value before the call), result, threw,
           after.<param> (the argument as the call left it), old.<param> (the value before, said explicitly)
```

`result`, `threw`, `after` and `old` always mean what the list above says, also when a parameter has one of these names. Such a parameter is reached as `old.<name>` (its value before the call) and `after.<name>` (as the call left it): for `fn f(result: Num): Num`, `result` is the return value and `old.result` the argument. When a rule writes such a name bare and cannot be parsed or evaluated, its error ends with a hint saying this.

Loosest to tightest: `implies`, `or`, `and`, `not`, comparisons and `in`, `+ -`, `* / %`, unary `-`, `.` and `[]`. Comparisons do not chain. There are no list or object literals, no definitions, no assignment and no calls into the program.

## How it is checked

- Inputs: the arguments of every `example` and `observed` line, then up to 50 generated inputs per function (`--rule-inputs <n>` changes the cap). Generated inputs are single structural edits and seeded variations of those arguments (a number negated or set to 0, an item dropped, repeated or reordered, a string swapped for another example's), the same generator as `openarc check --oracle`, kept only when they fit the parameter types.
- A rule must give `true` or `false`. A rule that reads `result` skips the calls that threw, unless it also reads `threw`; on a call that threw, `result` is undefined.
- `after.<param>` is the argument as the call left it; for a call that changed nothing it equals the parameter.
- A rule that cannot be evaluated on a call (a field of `null`, a string compared with a number) counts as broken by that call, and the line says why. A rule that does not parse, or names something unknown, is `unparsable`: `rule x: cannot parse: expected a value, found the end at column 14`.
- A broken or unparsable rule makes `--check` exit 1.
- A plain `openarc decompile` run evaluates the rules too, on the calls it makes anyway (the `example` and `observed` lines' arguments and the inputs it derives), with no generated inputs: `--check` is the thorough pass. A broken or unparsable rule makes the function `failing` in `.openarc/decompile.json`, with `why` in the words `--check` prints (`rule bounded: broken by (-50) -> -50`), so `openarc status` counts it. A module whose code is unchanged is not run again, so a rule added to it is evaluated on the next run that executes it (`--fresh` forces one) or by `--check`. `arc accept` keeps a body only when its rules hold ([[Arc Sync]]).

## Examples

```
fn survivalTick(stats: Stats, env: Weather): Tick
  rule bounded: after.stats in Stats and after.stats.water in 0..100
  rule drains: after.stats.water <= old.stats.water
```

```
fn dedupe(xs: [Str]): [Str]
  rule shorter: len(result) <= len(xs)
  rule kept: all(xs, x => any(result, y => y == x))
  rule untouched: after.xs == xs
```

```
fn parsePort(text: Str): Int
  rule valid: threw or result in 1..65535
  rule empty: text == "" implies threw
```

## Limits

- Values are JSON as the sandbox reports them: a function, class instance or `Map` in a result is whatever its JSON form is.
- Generated inputs come from the written arguments: a function with no `example` or `observed` line is checked on nothing (`held on 0 inputs`).
- Numbers compare within a relative tolerance of 1e-9; there is no exact operator.
