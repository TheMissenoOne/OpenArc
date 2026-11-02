(numbers) => {
  const out: number[] = [];
  for (const n of numbers) {
    const groups: number[] = arc.hole<number[]>("the 7-bit groups of n, most significant first, at least one group (use unsigned arithmetic: n can reach 0xFFFFFFFF)");
    out.push(...groups.map((g, i) => arc.hole<number>("g, with the high bit 0x80 set on every group except the last")));
  }
  return out;
}
