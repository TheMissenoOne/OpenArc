Gold context (from the instructions and stub only):
- transpose(rows: string[]): string[]: input rows of text, output rows of the transposed text. Output row c is input column c read top to bottom; the number of output rows is the length of the longest input row.
- Rows of different lengths: pad to the LEFT with spaces, never pad to the right. A missing character in a column is a space only when some LATER row (below it) still has a character in that column; otherwise the output row just ends.
- All characters of the input appear in the output, including spaces: if an input column has only spaces in its bottom-most row(s), those spaces stay at the right end of the output row.
- Instruction examples: ["ABC","DEF"] -> ["AD","BE","CF"]; ["ABC","DE"] -> ["AD","BE","C"]; ["AB","DEF"] -> ["AD","BE"," F"].
- Useful built-ins: String.prototype.padEnd / padStart, String.prototype.charAt(i) (returns "" past the end), Math.max.
