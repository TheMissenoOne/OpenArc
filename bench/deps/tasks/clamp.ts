import * as arc from "open-arc";

type Clamp = (n: number, lo: number, hi: number) => number;

export const clampSpec = arc.defineRegion<Clamp>({
  id: "math.clamp",
  intent: "n limited to the range [lo, hi]: lo when n < lo, hi when n > hi, else n. lo <= hi.",
  examples: [
    { args: [5, 0, 10], expected: 5 },
    { args: [-3, 0, 10], expected: 0 },
    { args: [12, 0, 10], expected: 10 },
  ],
});
