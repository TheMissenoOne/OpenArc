(size) => {
  const matrix: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  arc.hole("write the numbers 1..size*size into matrix in the spiral order the instructions describe");
  return matrix;
}
