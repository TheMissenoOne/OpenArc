Gold context (from the instructions and stub only):
- answer(question: string): number. Questions look like "What is <number>( <operation> <number>)*?".
- Numbers can be large and negative (e.g. "-3").
- Operations: "plus" (+), "minus" (-), "multiplied by" (*, two words), "divided by" (/, two words; integer results in the instructions' examples).
- Evaluate strictly left to right, ignoring the usual precedence: "What is 3 plus 2 multiplied by 3?" -> 15, not 9. "What is 5 plus 13 plus 6?" -> 24. "What is 5?" -> 5.
- Reject (throw an Error) on: unsupported operations ("What is 52 cubed?"), non-math questions ("Who is the President of the United States"), invalid syntax ("What is 1 plus plus 2?").
- Useful built-ins: Number.parseInt(s, 10), Number.isNaN, String.prototype.match / replace / split / startsWith / endsWith.
