(input) => {
  const out: number[] = [];
  const visit = (items: Nested): void => {
    for (const item of items) {
      arc.hole("handle one item of a nested array of any depth: numbers go to out, nested arrays are flattened via visit, null-like values are excluded");
    }
  };
  visit(input);
  return out;
}
