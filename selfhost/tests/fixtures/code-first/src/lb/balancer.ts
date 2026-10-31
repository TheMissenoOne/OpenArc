/** @arc module lb */
import * as arc from "open-arc";

export interface Backend {
  id: string;
  healthy: boolean;
  weight: number;
}

/** Routes requests to backends. Implementations keep their own rotation state. */
export interface Balancer {
  /** The backend for one request; null when no backend is healthy. */
  pick(key: string): string | null;
  /** Take a backend out of rotation. */
  markDown(id: string): void;
  /** The backends that can take requests now, in list order. */
  healthy(): Backend[];
}

export class RoundRobin implements Balancer {
  readonly backends: Backend[];
  /** Position in healthy() of the next pick. */
  next = 0;

  constructor(backends: Backend[]) {
    this.backends = backends.map((b) => ({ ...b }));
  }

  healthy(): Backend[] {
    return this.backends.filter((b) => b.healthy);
  }

  /**
   * The next healthy backend in rotation, in list order, wrapping around.
   * @param key ignored: round-robin does not look at keys
   * @returns the backend id, or null when no backend is healthy
   */
  pick(key: string): string | null {
    return arc.todo();
  }

  /**
   * Mark one backend unhealthy. The rotation keeps its position.
   * @throws Error "unknown backend <id>" when no backend has that id
   * @arc calls none
   */
  markDown(id: string): void {
    return arc.todo();
  }
}

/**
 * 32-bit FNV-1a over the UTF-16 code units (h = 2166136261; h = Math.imul(h ^ unit, 16777619) >>> 0). Unsigned.
 * @arc id lb.ringHash
 */
export function hash32(text: string): number {
  return arc.todo();
}

arc.configure(hash32, { examples: [{ args: [""], expected: 2166136261 }] });
