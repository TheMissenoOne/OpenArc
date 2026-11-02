(n) => {
  const lines: string[] = [];
  arc.hole("push the lines of verse n (1 = fly ... 8 = horse) of the song onto lines, one string per line, without newline characters");
  return lines.map((line) => line + "\n").join("");
}
