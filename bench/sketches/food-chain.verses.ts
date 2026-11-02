(start, end) => {
  const out: string[] = [];
  for (let n = start; n <= end; n++) out.push(verse(n));
  return out.join(arc.hole<string>("the separator between two consecutive verses"));
}
