(rows) => {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const out: string[] = [];
  for (let c = 0; c < width; c++) {
    out.push(arc.hole<string>("output row c: column c of the input read top to bottom, padded and trimmed as the instructions say"));
  }
  return out;
}
