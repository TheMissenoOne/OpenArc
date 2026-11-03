export const meta = { export: "compare", expectLib: true, note: "e.g. semver" };
const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0", "10.0.0"];
export const cases = [
  ...chain.slice(1).map((v, i) => ({ args: [chain[i], v], expected: -1 })),
  ...chain.slice(1).map((v, i) => ({ args: [v, chain[i]], expected: 1 })),
  { args: ["1.0.0+build.1", "1.0.0+build.2"], expected: 0 },
  { args: ["1.0.0-rc.1+x", "1.0.0-rc.1"], expected: 0 },
  { args: ["1.0.0-2", "1.0.0-10"], expected: -1 },
  { args: ["1.0.0-a", "1.0.0-1"], expected: 1 },
  { args: ["0.0.9", "0.0.10"], expected: -1 },
];
