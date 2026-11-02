(rows) => {
  let total = 0;
  const corners: [number, number][] = arc.hole<[number, number][]>("every (row, column) holding '+'");
  for (const [r1, c1] of corners)
    for (const [r2, c2] of corners)
      if (r2 > r1 && c2 > c1 && arc.hole<boolean>("(r1,c2) and (r2,c1) are '+', the top and bottom edges between c1 and c2 are only '-' or '+', and the left and right edges between r1 and r2 are only '|' or '+'")) total++;
  return total;
}
