Gold context (from the instructions and stub only):
- ofSize(size: number): number[][] returns a size x size matrix (array of rows).
- Filled with 1, 2, ..., size*size, starting at the top-left corner and moving clockwise inward: right along the top row, down the right column, left along the bottom row, up the left column, then the same on the inner ring.
- Instruction examples: size 3 -> rows [1,2,3], [8,9,4], [7,6,5]; size 4 -> rows [1,2,3,4], [12,13,14,5], [11,16,15,6], [10,9,8,7].
- size 0 -> [] (no rows).
- Useful built-ins: Array.from({ length: n }, () => new Array<number>(n).fill(0)).
