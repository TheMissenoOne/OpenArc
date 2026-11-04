import * as arc from "open-arc";

type Slugify = (s: string) => string;

export const slugifySpec = arc.defineRegion<Slugify>({
  id: "text.slugify",
  intent: [
    "A lowercase URL slug. First transliterate letters to ASCII: drop diacritics (é -> e, ñ -> n, å -> a) and map",
    "ß -> ss, æ -> ae, œ -> oe, ø -> o, ł -> l, þ -> th (and their capitals). Then remove every character that is not an",
    "ASCII letter, digit, space or hyphen, turn each run of spaces and hyphens into one '-', and trim '-' at both ends.",
  ],
  examples: [
    { args: ["Hello, World!"], expected: "hello-world" },
    { args: ["Crème Brûlée"], expected: "creme-brulee" },
    { args: [""], expected: "" },
  ],
});
