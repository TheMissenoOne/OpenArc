(bytes) => {
  const out: number[] = [];
  let value = 0;
  for (const b of bytes) {
    value = arc.hole<number>("value shifted left by 7 plus the low 7 bits of b, kept unsigned (multiply by 128 instead of << to avoid sign overflow)");
    if ((b & 0x80) === 0) {
      out.push(value);
      value = 0;
    }
  }
  arc.hole("if the last byte had its high bit set, the sequence is incomplete: throw new Error('Incomplete sequence')");
  return out;
}
