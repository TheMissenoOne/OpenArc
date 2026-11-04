export const meta = { export: "parse", expectLib: true, note: "e.g. csv-parse/sync, papaparse" };
export const cases = [
  { args: ["a,b\r\n1,2\r\n"], expected: [["a", "b"], ["1", "2"]] },
  { args: ['"he said ""hi""",x'], expected: [['he said "hi"', "x"]] },
  { args: ['"line1\nline2",b\nc,d'], expected: [["line1\nline2", "b"], ["c", "d"]] },
  { args: [',,\n'], expected: [["", "", ""]] },
  { args: ['"",a'], expected: [["", "a"]] },
  { args: ['a,"b,c",d\r\ne,f,g'], expected: [["a", "b,c", "d"], ["e", "f", "g"]] },
  { args: ['x\n\ny'], expected: [["x"], [""], ["y"]] },
  { args: ['"a\r\nb"'], expected: [["a\r\nb"]] },
];
