(haystack, needle) => {
  let lo = 0;
  let hi = haystack.length - 1;
  let found = -1;
  while (lo <= hi && found === -1) {
    const mid = arc.hole<number>("index of the middle element of the part haystack[lo..hi] not yet eliminated");
    if (haystack[mid] === needle) {
      found = mid;
    } else {
      arc.hole("eliminate the middle element and the half that cannot contain needle, by moving lo or hi");
    }
  }
  arc.hole("every element has been eliminated when found === -1: handle needle not being in the list");
  return found;
}
