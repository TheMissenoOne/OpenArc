export const meta = { export: "deepEqual", expectLib: true, note: "e.g. dequal, fast-deep-equal/es6" };
export const cases = [
  { args: [NaN, NaN], expected: true },
  { args: [new Date(5), new Date(5)], expected: true },
  { args: [new Date(5), new Date(6)], expected: false },
  { args: [/a/g, /a/g], expected: true },
  { args: [/a/g, /a/i], expected: false },
  { args: [new Map([["k", { x: 1 }]]), new Map([["k", { x: 1 }]])], expected: true },
  { args: [new Map([["k", 1]]), new Map([["k", 2]])], expected: false },
  { args: [new Set([1, 2]), new Set([2, 1])], expected: true },
  { args: [new Set([1, 2]), new Set([1, 3])], expected: false },
  { args: [[1, [2, [3]]], [1, [2, [3]]]], expected: true },
  { args: [{ a: undefined }, { b: undefined }], expected: false },
  { args: [null, {}], expected: false },
];
