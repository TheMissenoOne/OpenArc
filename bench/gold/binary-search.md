Gold context (from the instructions and stub only):
- Input: haystack, a list of numbers sorted ascending; needle, the number looked for. Output: the index of needle in haystack.
- Algorithm stated by the instructions: compare the middle element of the remaining part with needle; equal -> found; middle greater -> eliminate it and everything after it; middle smaller -> eliminate it and everything before it; repeat; when every element is eliminated, needle is not in the list.
- The stub's return type is `number | never`: the not-found case does not return a number (it throws an Error).
- Useful built-ins: Math.floor(x: number): number.
