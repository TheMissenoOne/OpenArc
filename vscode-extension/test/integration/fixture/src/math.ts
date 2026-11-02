// Integration-test fixture. `arc` is declared so the file needs no install.
declare const arc: any;

export const addSpec = arc.defineRegion({ id: "math.add", intent: "add two numbers", examples: [{ args: [1, 2], expected: 3 }] });
export const subSpec = arc.defineRegion({ id: "math.sub", intent: "subtract b from a", examples: [{ args: [3, 1], expected: 2 }] });
export const mulSpec = arc.defineRegion({ id: "math.mul", intent: "multiply two numbers", examples: [{ args: [2, 3], expected: 6 }] });
export const divSpec = arc.defineRegion({ id: "math.div", intent: "divide a by b", examples: [{ args: [6, 3], expected: 2 }] });

// @openarc:begin math.add
export const add = (a: number, b: number): number => arc.todo("math.add");
// @openarc:end math.add

// @openarc:begin math.sub
export const sub = (a: number, b: number): number => a - b;
// @openarc:end math.sub

// @openarc:begin math.mul
export const mul = (a: number, b: number): number => arc.todo("math.mul");
// @openarc:end math.mul

// @openarc:begin math.div
export const div = (a: number, b: number): number => arc.todo("math.div");
// @openarc:end math.div
