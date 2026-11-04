import * as arc from "open-arc";

type DeepEqual = (a: unknown, b: unknown) => boolean;

export const deepEqualSpec = arc.defineRegion<DeepEqual>({
  id: "obj.deepEqual",
  intent: [
    "Structural equality. Primitives: === except NaN equals NaN. Objects must have the same constructor: arrays",
    "element-wise; Date by time; RegExp by source and flags; Map by size and deep-equal values per key; Set by size",
    "and the same members (===); plain objects by the same own enumerable keys with deep-equal values.",
  ],
  examples: [
    { args: [{ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }], expected: true },
    { args: [{ a: 1 }, { a: 1, b: 2 }], expected: false },
    { args: [[], {}], expected: false },
  ],
});
