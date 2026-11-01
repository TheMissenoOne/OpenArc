Gold context (from the instructions and stub only):
- Input: a phrase (string). Output: its acronym (string), upper-case letters only.
- Words are separated by whitespace AND by hyphens ("Liquid-crystal display" -> "LCD").
- Every other punctuation character is removed before forming the acronym ("Thank George It's Friday!" -> "TGIF"; the apostrophe does not split a word).
- Instruction table: "As Soon As Possible" -> "ASAP", "Liquid-crystal display" -> "LCD", "Thank George It's Friday!" -> "TGIF".
- Useful built-ins: String.prototype.split(separator: string | RegExp): string[]; String.prototype.replace(pattern: RegExp, replacement: string): string; String.prototype.toUpperCase(): string; Array.prototype.filter / map / join.
