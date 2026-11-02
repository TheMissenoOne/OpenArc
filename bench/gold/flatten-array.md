Gold context (from the instructions and stub only):
- Type: `interface Nested extends Array<number | null | undefined | Nested> {}`: each item is a number, null, undefined, or another Nested array, to any depth.
- Output: every number in the input, in left-to-right order, as one flat number[].
- null-like values (null and undefined) are excluded from the output, at every depth.
- Instruction example: [1, [2, 6, null], [[null, [4]], 5]] -> [1, 2, 6, 4, 5].
- Useful built-ins: Array.isArray(value: unknown): boolean; Array.prototype.flat(depth?: number); Array.prototype.push(...items).
