export const meta = { export: "slugify", expectLib: true, note: "e.g. slugify (lower, strict)" };
export const cases = [
  { args: ["Straße in Ærøskøbing"], expected: "strasse-in-aeroskobing" },
  { args: ["Łódź œuvre Þór"], expected: "lodz-oeuvre-thor" },
  { args: ["  --Already--Slugged--  "], expected: "already-slugged" },
  { args: ["it's 100 fine?"], expected: "its-100-fine" },
  { args: ["Ångström São Paulo"], expected: "angstrom-sao-paulo" },
  { args: ["ÆØÅ æøå"], expected: "aeoa-aeoa" },
];
