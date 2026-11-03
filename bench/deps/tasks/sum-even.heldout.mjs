export const meta = { export: "sumEven", expectLib: false };
export const cases = [
  { args: [[2, 4, 6]], expected: 12 }, { args: [[1, 3, 5]], expected: 0 }, { args: [[0]], expected: 0 },
  { args: [[-4, -3, 8]], expected: 4 }, { args: [[1.5, 2]], expected: 2 },
];
