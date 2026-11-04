import * as arc from "open-arc";

type Compare = (a: string, b: string) => -1 | 0 | 1;

export const compareSpec = arc.defineRegion<Compare>({
  id: "semver.compare",
  intent: [
    "Compare two Semantic Versioning 2.0.0 version strings by precedence: -1 if a < b, 0 if equal, 1 if a > b.",
    "A pre-release version (1.0.0-alpha) sorts before its release; pre-release identifiers are compared dot by dot,",
    "numerically when both are numeric, lexically (ASCII) otherwise, numeric before alphanumeric, and a shorter set of",
    "identifiers sorts first when all preceding ones are equal. Build metadata (+...) is ignored.",
  ],
  examples: [
    { args: ["1.2.3", "1.2.3"], expected: 0 },
    { args: ["1.10.0", "1.9.0"], expected: 1 },
    { args: ["1.0.0-alpha", "1.0.0"], expected: -1 },
  ],
});
