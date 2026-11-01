/** @arc module lb */
import * as arc from "open-arc";

export interface Backend {
  id: string;
  healthy: boolean;
  /** Open connections now; only LeastConnections reads it. */
  connections: number;
}

/** Route requests to backends. Only healthy backends are eligible; with none, every pick is null. */
export interface Balancer {
  /** The backend id for one request, or null when no backend is healthy. */
  pick(key: string): string | null;
  /** Take a backend out of rotation. Throws "unknown backend <id>" for an id it doesn't have. */
  markDown(id: string): void;
}

/** Shared state and helpers: an abstract base, written by hand. Subclasses write pick. */
export abstract class Strategy implements Balancer {
  readonly backends: Backend[];
  constructor(backends: Backend[]) {
    this.backends = backends.map((b) => ({ ...b }));
  }
  /** The healthy backends, in list order. */
  healthy(): Backend[] {
    return this.backends.filter((b) => b.healthy);
  }
  markDown(id: string): void {
    const b = this.backends.find((x) => x.id === id);
    if (!b) throw new Error(`unknown backend ${id}`);
    b.healthy = false;
  }
  abstract pick(key: string): string | null;
}

export class RoundRobin extends Strategy {
  /** Position in healthy() of the next pick. */
  next = 0;
  /** The next healthy backend in list order, wrapping around. Keys are ignored. */
  pick(key: string): string | null {
    return arc.todo();
  }
}

export class LeastConnections extends Strategy {
  /** The healthy backend with the fewest connections (ties: first in list order); it then has one more. */
  pick(key: string): string | null {
    return arc.todo();
  }
}

export class ConsistentHash extends Strategy {
  static readonly REPLICAS = 16;
  /**
   * Each healthy backend owns REPLICAS points on a ring: hash32(`${id}#${i}`) for i in 0..REPLICAS-1. The pick is the
   * owner of the first point at or after hash32(key), wrapping around to the smallest point (ties: smaller id first).
   */
  pick(key: string): string | null {
    return arc.todo();
  }
}

/**
 * 32-bit FNV-1a over the UTF-16 code units: h = 2166136261, then for each unit h = Math.imul(h ^ unit, 16777619) >>> 0.
 * @arc effects none
 */
export function hash32(text: string): number {
  return arc.todo();
}

// The customization layer: JSON examples still work, next to the tests.
arc.configure(hash32, { examples: [{ args: [""], expected: 2166136261 }, { args: ["a"], expected: 3826002220 }] });
