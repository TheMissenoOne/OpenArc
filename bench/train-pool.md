# MultiPL-E training pool (issue #63)

**These tasks are for training only.** They exist to collect verified compile traces from a teacher model for fine-tuning a small model. The bench `dev` split, the `test` split and evolve-multi (`exercises.json`, `matrix-evolve-multi.json`) are **never** trained on, and nothing from this pool goes into a benchmark table.

## Source

[MultiPL-E](https://huggingface.co/datasets/nuprl/MultiPL-E) (MIT), configs `humaneval-ts` (HumanEval) and `mbpp-ts` (MBPP), split `test`, at dataset revision `28441b6024e71d4a1c1c0f6bf171c935cd5a43f2` (main, last modified 2025-07-15). `fetch-multipl-e.sh` downloads both parquet files at that revision and converts them to JSONL (pyarrow through `uv`, into uv's cache, not a repo dependency). The data stays outside this repo.

## Counts

| | HumanEval | MBPP | total |
|---|---|---|---|
| problems | 159 | 390 | 549 |
| converted | 79 | 272 | **351** |
| skipped | 1 | 5 | 6 |
| decontaminated | 79 | 113 | 192 |

## Conversion (`train-pool.mjs`)

A dataset adapter, not a second harness: it writes the pool in ts-bench's layout (`<pool>/repos/exercism-typescript/exercises/practice/<task>/{<task>.test.ts, .docs/instructions.md}`) plus `<pool>/exercises.json` in the shape of `bench/exercises.json`, so `run.mjs`, `lib/adapter.mjs` and `lib/common.mjs` run it unchanged; `BENCH_EXERCISES=<pool>/exercises.json` points `lib/common.mjs` at it.

- Task id: `he<n>-<name>` / `mbpp<n>-<name>` (the MultiPL-E `name` is kept in `functions.<id>.source`).
- Signature: the prompt's `function f(params): T {` becomes `fns: { f: "(params) => T" }`, with `f` camelCased (`has_close_elements` -> `hasCloseElements`, in the doc comment and tests too): OpenArc names the compiled export after the region id, whose segments are `[a-z][a-zA-Z0-9]*`.
- Intent: the prompt's doc comment (MultiPL-E's `tsthon` typo fixed to `TypeScript`), behind the harness's usual `` Exercise "<id>": implement `f`. `` header.
- Tests: each `assert.deepEqual(candidate(...), v)` line becomes one jest test (`toEqual`). The bench split rule then applies as for Exercism: the recorder keeps JSON-encodable asserts, the first `min(3, floor(eligible / 2))` become the spec's examples, the rest are hidden tests graded after the compile (`heldOut` in `tasks.jsonl`). HumanEval tasks (about 7 asserts) get 3 examples; MBPP tasks (3 asserts) get 1 example and 2 hidden tests.
- Skipped, with the reason in `exercises.json` `skipped`: `he34-unique` (1 assert, no public example under the split rule), `mbpp563-extract-values` and `mbpp725-extract-quotation` (unescaped quotes in the translated asserts: the test file does not parse), and `mbpp262-split-two-parts`, `mbpp407-rearrange-bigger`, `mbpp587-list-tuple` (return type `any`: no contract, and OpenArc rejects the spec with TS2322).

## Decontamination

A problem whose name or intent matches a pattern tied to a bench exercise (every `exercises.json` function, set and skipped exercise, which covers evolve-multi's nine) is dropped and listed in `exercises.json` `decontaminated`. Deliberately generous: a false drop costs one training task, a miss leaks a benchmark answer into the fine-tune. Dropped, by pattern:

- matches /sub.?list|sub.?array|sub.?sequence/ (sublist): he114-minsubarraysum, mbpp69-is-sublist, mbpp104-sort-sublists, mbpp245-max-sum, mbpp282-sub-list, mbpp306-max-sum-increasing-subseq, mbpp425-count-element-in-list, mbpp457-find-min, mbpp460-extract, mbpp463-max-subarray-product, mbpp468-max-product, mbpp559-max-sub-array-sum, mbpp562-find-max-length, mbpp569-sort-sublists, mbpp576-is-sub-array, mbpp612-merge, mbpp615-average-tuple, mbpp734-sum-of-subarray-prod, mbpp747-lcs-of-three, mbpp782-odd-length-sum
- matches /prime|sieve/ (prime-factors, sieve): he25-factorize, he31-is-prime, he39-prime-fib, he59-largest-prime-factor, he75-is-multiply-prime, he78-hex-key, he82-prime-length, he94-skjkasdkd, he96-count-up-to, he127-intersection, he143-words-in-sentence, he150-x-or-y, mbpp3-is-not-prime, mbpp256-count-primes-nums, mbpp260-newman-prime, mbpp605-prime-num
- matches /squares?\b/ (difference-of-squares): he133-sum-squares, he142-sum-squares, he151-double-the-difference, mbpp8-square-nums, mbpp17-square-perimeter, mbpp72-dif-square, mbpp129-magic-square-test, mbpp244-next-perfect-square, mbpp267-square-sum, mbpp287-square-sum, mbpp589-perfect-squares, mbpp721-maxaverageofpath, mbpp803-is-perfect-square
- matches /series|consecutive|adjacent/ (largest-series-product, series): he5-intersperse, he80-is-happy, he140-fix-spaces, mbpp162-sum-series, mbpp291-count-no-of-ways, mbpp472-check-consecutive, mbpp592-sum-of-product, mbpp630-get-coordinates, mbpp730-consecutive-duplicates, mbpp740-tuple-to-dict, mbpp766-pair-wise, mbpp778-pack-consecutive-duplicates
- matches /divisor|divisib|amicable|aliquot/ (perfect-numbers, prime-factors): he13-greatest-common-divisor, he24-largest-divisor, he33-sort-third, mbpp75-find-tuples, mbpp77-is-diff, mbpp96-divisor, mbpp123-amicable-numbers-sum, mbpp126-sum, mbpp295-sum-div, mbpp745-divisible-by-digits, mbpp781-count-divisors
- matches /binary/ (binary-search, variable-length-quantity, secret-handshake): he11-string-xor, he79-decimal-to-binary, he84-solve, he103-rounded-avg, he116-sort-array, mbpp99-decimal-to-binary, mbpp125-find-length, mbpp224-count-set-bits, mbpp595-min-swaps, mbpp751-check-min-heap
- matches /cipher|encrypt|decrypt|caesar|rot13|rotat|shift/ (atbash-cipher, rotational-cipher, simple-cipher): he65-circular-shift, he89-encrypt, he109-move-one-ball, he154-cycpattern-check, mbpp9-find-rotations, mbpp109-odd-equivalent, mbpp304-find-element, mbpp743-rotate-right, mbpp799-left-rotate, mbpp802-count-rotation
- matches /bracket|paren/ (matching-brackets): he1-separate-paren-groups, he6-parse-nested-parens, he56-correct-bracketing, he61-correct-bracketing, he119-match-parens, he132-is-nested, mbpp640-remove-parenthesis, mbpp771-check-expression
- matches /palindrom/ (palindrome-products): he10-make-palindrome, he48-is-palindrome, he72-will-it-fly, he73-smallest-change, he107-even-odd-palindrome, he112-reverse-delete, mbpp100-next-smallest-palindrome, mbpp247-lps
- matches /power.{0,4}(of.)?(2|two)\b|\bbits?\b|bitwise/ (grains, secret-handshake, variable-length-quantity): he76-is-simple-power, mbpp6-differ-at-one-bit-pos, mbpp138-is-sum-of-powers-of-two, mbpp167-next-power-of-2, mbpp228-all-bits-set-in-the-given-range, mbpp388-highest-power-of-2, mbpp399-bitwise-xor, mbpp735-toggle-middle-bits
- matches /verse|song|lyric|twelve days/ (twelve-days, house, food-chain): he105-by-length, he161-solve, mbpp56-checks, mbpp131-reverse-vowels, mbpp456-reverse-string-list, mbpp604-reverse-words, mbpp644-reverse-array-upto-k, mbpp757-count-reverse-pairs
- matches /clock|gigasecond|date|time/ (clock, gigasecond): he18-how-many-times, he36-fizz-buzz, he123-get-odd-collatz, he124-valid-date, mbpp223-is-majority, mbpp286-max-sub-array-sum-repeated, mbpp427-change-date-format
- matches /flatten|nested/ (flatten-array): he87-get-row, mbpp65-recursive-list-sum, mbpp97-frequency-lists, mbpp297-flatten-list, mbpp401-add-nested-tuples, mbpp580-extract-even, mbpp791-remove-nested
- matches /multiple/ (sum-of-multiples): he12-longest, he68-pluck, he147-get-max-triples, he158-find-max, mbpp439-multiple-to-single
- matches /triangle|pythagor|triplet/ (triangle, pythagorean-triplet): he45-triangle-area, he71-triangle-area, he157-right-angle-triangle, mbpp293-otherside-rightangle, mbpp626-triangle-area
- matches /factor/ (prime-factors): he106-f, he139-special-factorial, mbpp308-large-product, mbpp453-sumoffactors, mbpp577-last-digit-factorial
- matches /word.?count|count.{0,20}words|frequen|histogram/ (word-count): he111-histogram, mbpp88-freq-count, mbpp130-max-occurrences, mbpp168-frequency, mbpp283-validate
- matches /search/ (binary-search, word-search): he69-search, mbpp119-search, mbpp280-sequential-search, mbpp607-find-literals
- matches /matrix|matrices|spiral|saddle|grid/ (spiral-matrix, saddle-points, matrix): he115-max-fill, he129-minpath, mbpp12-sort-matrix, mbpp611-max-of-nth
- matches /\bbase\b|base \d|_base|radix/ (all-your-base): he44-change-base, mbpp581-surface-area, mbpp724-power-base-sum
- matches /same.?char|shuffle/ (anagram): he54-same-chars, he86-anti-shuffle, mbpp396-check-char
- matches /minesweeper|mine/ (minesweeper): he110-exchange, he152-compare, mbpp164-are-equivalent
- matches /wordy|evaluat|algebra|expression/ (wordy): he138-is-equal-to-sum-even, he160-do-algebra
- matches /fraction|rational/ (rational-numbers): he144-simplify, he153-strongest-extension
- matches /resistor|colou?r/ (resistor-color-trio): mbpp255-combinations-colors, mbpp783-rgb-to-hsv
- matches /bank/ (bank-account): he3-below-zero
- matches /'one'|numberal/ (say): he19-sort-numbers
- matches /perfect/ (perfect-numbers): he41-car-race-collision
- matches /run.?length|encod|decod|compress/ (run-length-encoding, atbash, variable-length-quantity): he93-encode
- matches /number.{0,20}words|in words|to words|spell/ (say): he101-words-string
- matches /roman/ (roman-numerals): he156-int-to-mini-roman
- matches /\bset\b/ (custom-set): mbpp67-bell-number
- matches /relative|family|ancestor/ (relative-distance): mbpp229-re-arrange-array
- matches /complex/ (complex-numbers): mbpp252-convert
- matches /rectangle/ (rectangles): mbpp458-rectangle-area
- matches /armstrong|narcissist/ (armstrong-numbers): mbpp598-armstrong-number

## Run the teacher pass

Config `A` (OpenArc L0, repair, 3 attempts) with `OPENARC_TRACES=1` (`matrix-train.json` sets it through the config's `env`). Needs an OpenArc build with traces (PR #64). One model on the machine: the teacher's `llama-server` on :8080, nothing else loaded.

```bash
cd bench
./fetch-multipl-e.sh /mnt/data/tools/ft/data/multipl-e
node train-pool.mjs --src /mnt/data/tools/ft/data/multipl-e --out /mnt/data/tools/ft/data/train-pool
(cd ../stage0 && node tools/build.ts && cd build && npm pack)   # open-arc-<version>.tgz with traces
# fill matrix-train.json: runs[0].model and backend.info from the running teacher
BENCH_EXERCISES=/mnt/data/tools/ft/data/train-pool/exercises.json node run.mjs \
  --dataset /mnt/data/tools/ft/data/train-pool --matrix matrix-train.json \
  --out /mnt/data/tools/ft/runs/train-pool-<teacher> --work /mnt/data/tools/ft/work \
  --oa ../stage0/build/open-arc-<version>.tgz
```

Use a fresh `--work`: `run.mjs` caches the OpenArc install by tgz file name, so an older build of the same version without traces would be reused. Resume as usual (same command, same `--out`).

Results, in `--out`:

- `tasks.jsonl`: one line per task; `publicPass` (every region verified), `attempts`, `heldOut` (hidden tests passed / total);
- `traces.jsonl`: every task's `.openarc/traces.jsonl`, appended after the task, each line with `task`, `config` and `seed` added. Train on `outcome: "verified"` lines of tasks whose `heldOut.allPass` is true (join on `task`).
