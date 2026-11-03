export const meta = { export: "clamp", expectLib: false };
export const cases = [
  { args: [0, 0, 10], expected: 0 }, { args: [10, 0, 10], expected: 10 }, { args: [-5, -10, -1], expected: -5 },
  { args: [3, 3, 3], expected: 3 }, { args: [1.5, 0, 1], expected: 1 }, { args: [-0.5, 0, 1], expected: 0 },
];
