(character) => {
  const n = arc.hole<number>("distance of character from 'A' (0 for 'A')");
  const rows: string[] = [];
  for (let i = 0; i <= n; i++) rows.push(arc.hole<string>("row i: width 2n+1, the letter 'A'+i at columns n-i and n+i, spaces elsewhere"));
  return arc.hole<string>("the rows, then the rows before the last in reverse, joined with newlines");
}
