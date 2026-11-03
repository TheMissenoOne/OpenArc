import * as arc from "open-arc";

type Parse = (text: string) => string[][];

export const parseSpec = arc.defineRegion<Parse>({
  id: "csv.parse",
  intent: [
    "Parse RFC 4180 CSV text into records of fields. Fields are separated by commas and records by \\n or \\r\\n.",
    "A field may be wrapped in double quotes; inside quotes a doubled quote \"\" is one quote character, and commas and",
    "line breaks are part of the field. One trailing line break does not start an empty record. Empty input gives [].",
  ],
  examples: [
    { args: ["a,b\n1,2\n"], expected: [["a", "b"], ["1", "2"]] },
    { args: ["\"x, y\",z"], expected: [["x, y", "z"]] },
    { args: [""], expected: [] },
  ],
});
