import * as arc from "open-arc";

type Capitalize = (s: string) => string;

export const capitalizeWordsSpec = arc.defineRegion<Capitalize>({
  id: "text.capitalizeWords",
  intent: "s with the first character of every space-separated word upper-cased and the rest unchanged; spaces kept as they are.",
  examples: [
    { args: ["hello world"], expected: "Hello World" },
    { args: ["  a  bC"], expected: "  A  BC" },
    { args: [""], expected: "" },
  ],
});
