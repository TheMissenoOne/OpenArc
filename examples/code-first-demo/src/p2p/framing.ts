/** @arc module p2p */
import * as arc from "open-arc";

/** Decode a byte stream that arrives in chunks of any size. Bytes are numbers 0..255. */
export interface Decoder {
  /** Add one chunk; return every message it completes, in order. */
  push(chunk: number[]): string[];
  /** The bytes of an incomplete trailing frame. */
  pending(): number[];
}

/** A framing: how messages become bytes and back. Every framing obeys the laws in tests/framing.test.ts. */
export interface Framing {
  encode(message: string): number[];
  decoder(): Decoder;
}

export class LengthPrefixed implements Framing {
  /** The message's UTF-8 bytes (TextEncoder), prefixed with their count as a 4-byte unsigned big-endian integer. */
  encode(message: string): number[] {
    return arc.todo();
  }
  decoder(): Decoder {
    return new LengthPrefixedDecoder();
  }
}

export class LengthPrefixedDecoder implements Decoder {
  buf: number[] = [];
  /**
   * Append chunk to buf; while buf holds a whole frame (a 4-byte big-endian length, then that many bytes), cut it off
   * and decode its bytes as UTF-8 (TextDecoder).
   */
  push(chunk: number[]): string[] {
    return arc.todo();
  }
  pending(): number[] {
    return [...this.buf];
  }
}
