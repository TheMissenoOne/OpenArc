// Fake clock for the palette: init { now } (ms). snapshot(): { now }.
import { defineFake } from "open-arc";
import type { Clock } from "../../src/palette/loadBalancer.ts";

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export default defineFake<Clock>((init) => {
  const now = ((init ?? {}) as { now?: number }).now ?? 0;
  return { instance: { now: () => now }, snapshot: () => ({ now }) };
});
