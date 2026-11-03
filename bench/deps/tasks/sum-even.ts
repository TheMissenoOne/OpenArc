import * as arc from "open-arc";

type SumEven = (xs: number[]) => number;

export const sumEvenSpec = arc.defineRegion<SumEven>({
  id: "math.sumEven",
  intent: "The sum of the even integers in xs (negative ones included); 0 for an empty array.",
  examples: [
    { args: [[1, 2, 3, 4]], expected: 6 },
    { args: [[-2, 5]], expected: -2 },
    { args: [[]], expected: 0 },
  ],
});
