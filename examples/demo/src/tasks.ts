import * as arc from "@openarc/core";

type NormalizeTitle = (title: string) => string;

export const normalizeTitleSpec = arc.defineRegion<NormalizeTitle>({
  id: "tasks.normalizeTitle",
  intent: "Trim the title, collapse internal runs of whitespace to one space, and capitalize the first letter.",
  examples: [
    { args: ["  buy   milk "], expected: "Buy milk" },
    { args: ["x"], expected: "X" },
    { args: ["   "], expected: "" },
  ],
});

// @openarc:begin tasks.normalizeTitle
export const normalizeTitle: NormalizeTitle = (title) => {
  return  title.trim() // mine
    .replace(/\s+/g, ' ').charAt(0).toUpperCase() + title.trim().replace(/\s+/g, ' ').slice(1);
};
// @openarc:end tasks.normalizeTitle
