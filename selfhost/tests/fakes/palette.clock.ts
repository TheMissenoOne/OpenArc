// Fake clock for the palette: init { now } (ms). snapshot(): { now }.
import { defineFake } from "open-arc";
import type { Clock } from "../../src/palette/loadBalancer.ts";

export default defineFake<Clock>((init) => {
  const now = ((init ?? {}) as { now?: number }).now ?? 0;
  return { instance: { now: () => now }, snapshot: () => ({ now }) };
});
