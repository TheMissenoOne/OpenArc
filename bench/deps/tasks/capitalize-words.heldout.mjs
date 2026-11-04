export const meta = { export: "capitalizeWords", expectLib: false };
export const cases = [
  { args: ["a"], expected: "A" }, { args: ["already Capital"], expected: "Already Capital" },
  { args: ["x  y   z "], expected: "X  Y   Z " }, { args: ["123 abc"], expected: "123 Abc" }, { args: ["éclair au chocolat"], expected: "Éclair Au Chocolat" },
];
