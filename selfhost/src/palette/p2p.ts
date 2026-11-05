// OpenArc palette: a peer-to-peer protocol. Message framing (a concept with two variants), a handshake state machine
// with version negotiation, a bounded peer table, and gossip (bounded fanout, dedupe by message id, TTL).
// See README.md. Bytes are number[] (0..255) so examples stay JSON. The network is a port (Transport); the fake
// network in tests/fakes/palette.net.ts connects N peers, so multi-peer examples run deterministically in the sandbox.
import * as arc from "open-arc";

// ───────────────────────────── framing ─────────────────────────────
/** A decoded stream: every complete message, and the bytes of an incomplete trailing frame.
 * @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette).
 */
export type Decoded = { messages: string[]; rest: number[] };
/** The framing concept's interface: decode a byte stream that arrives in chunks.
 * @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette).
 */
export type Decoder = (chunks: number[][]) => Decoded;

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const framingConcept = arc.defineConcept({
  id: "framing",
  interface: "Decoder",
  intent: [
    "Decode a stream of frames that arrives in arbitrary chunks: a length prefix, then that many bytes of UTF-8. Frames may straddle chunks, prefixes included.",
    "Return every complete message in order, and the leftover bytes of an incomplete trailing frame (so a caller can prepend them to the next read).",
  ],
  laws: [
    { name: "whole frames decode in order", args: ["$fixture:twoFrames"], expected: { messages: ["hi", "there"], rest: [] } },
    { name: "a frame split across chunks is reassembled", args: ["$fixture:split"], expected: { messages: ["hi", "there"], rest: [] } },
    { name: "an incomplete frame is kept as rest", args: ["$fixture:partial"], expected: { messages: ["hi"], rest: "$fixture:partialRest" } },
    { name: "an empty message survives", args: ["$fixture:emptyMessage"], expected: { messages: [""], rest: [] } },
    { name: "no input, no messages", args: [[]], expected: { messages: [], rest: [] } },
    { name: "UTF-8 round trip", args: ["$fixture:utf8"], expected: { messages: ["olá ∑"], rest: [] } },
  ],
});

// ── p2p.encodeLengthPrefixed / p2p.decodeLengthPrefixed ───────── 4-byte big-endian length
type Encode = (message: string) => number[];

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const encodeLengthPrefixedSpec = arc.defineRegion<Encode>({
  id: "p2p.encodeLengthPrefixed",
  intent: "UTF-8 bytes of message (TextEncoder), prefixed with their count as a 4-byte unsigned big-endian integer.",
  examples: [
    { args: ["hi"], expected: [0, 0, 0, 2, 104, 105] },
    { args: [""], expected: [0, 0, 0, 0] },
    { args: ["olá ∑"], expected: [0, 0, 0, 8, 111, 108, 195, 161, 32, 226, 136, 145] },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin p2p.encodeLengthPrefixed
export const encodeLengthPrefixed: Encode = (message) => {
  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(message);
  const length = messageBytes.length;
  const lengthBytes = new Uint8Array(4);
  lengthBytes[0] = (length >> 24) & 0xFF;
  lengthBytes[1] = (length >> 16) & 0xFF;
  lengthBytes[2] = (length >> 8) & 0xFF;
  lengthBytes[3] = length & 0xFF;
  return [...lengthBytes, ...messageBytes];
};
// @openarc:end p2p.encodeLengthPrefixed

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const decodeLengthPrefixedSpec = arc.defineRegion<Decoder>({
  id: "p2p.decodeLengthPrefixed",
  concept: "framing",
  intent: "The prefix is a 4-byte unsigned big-endian length.",
  fixtures: {
    twoFrames: [[0, 0, 0, 2, 104, 105, 0, 0, 0, 5, 116, 104, 101, 114, 101]],
    split: [[0, 0], [0, 2, 104], [105, 0, 0, 0, 5, 116], [104, 101, 114, 101]],
    partial: [[0, 0, 0, 2, 104, 105, 0, 0, 0, 5, 116, 104]],
    partialRest: [0, 0, 0, 5, 116, 104],
    emptyMessage: [[0, 0, 0, 0]],
    utf8: [[0, 0, 0, 8, 111, 108, 195], [161, 32, 226, 136, 145]],
  },
  examples: [
    { name: "only part of a length prefix", args: [[[0, 0, 1]]], expected: { messages: [], rest: [0, 0, 1] } },
    { name: "empty chunks are fine", args: [[[], [0, 0, 0, 1], [], [33]]], expected: { messages: ["!"], rest: [] } },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin p2p.decodeLengthPrefixed
export const decodeLengthPrefixed: Decoder = (chunks) => {
  let messages: string[] = [];
  let rest: number[] = [];
  let buffer: number[] = [];
  let offset: number = 0;

  for (const chunk of chunks) {
    buffer = buffer.concat(chunk);
    while (buffer.length >= offset + 4) {
      const length = (buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
      if (buffer.length >= offset + 4 + length) {
        const message = new TextDecoder().decode(new Uint8Array(buffer.slice(offset + 4, offset + 4 + length)));
        messages.push(message);
        offset += 4 + length;
      } else {
        break;
      }
    }
  }

  rest = buffer.slice(offset);
  return { messages, rest };
};
// @openarc:end p2p.decodeLengthPrefixed

// ── p2p.encodeVarint / p2p.decodeVarint ───────────────────────── unsigned LEB128 length
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const encodeVarintSpec = arc.defineRegion<Encode>({
  id: "p2p.encodeVarint",
  intent: "UTF-8 bytes of message (TextEncoder), prefixed with their count as an unsigned LEB128 varint (7 bits per byte, low group first, high bit = more).",
  examples: [
    { args: ["hi"], expected: [2, 104, 105] },
    { args: [""], expected: [0] },
    { name: "a 2-byte length", args: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], expected: [128, 1, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97] },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin p2p.encodeVarint
export const encodeVarint: Encode = (message) => {
  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(message);
  const length = messageBytes.length;
  const varintBytes: number[] = [];
  let value = length;

  while (value > 0x7F) {
    varintBytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  varintBytes.push(value);

  return [...varintBytes, ...messageBytes];
};
// @openarc:end p2p.encodeVarint

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const decodeVarintSpec = arc.defineRegion<Decoder>({
  id: "p2p.decodeVarint",
  concept: "framing",
  intent: [
    "The prefix is an unsigned LEB128 varint (at most 5 bytes).",
    "Method: const buf = chunks.flat(); don't redeclare the parameter. Loop from at = 0: read at most 5 prefix bytes (n += (b & 127) * 2 ** shift); if the prefix or the payload is incomplete, stop. Decode buf.slice(i, i + n) with new TextDecoder().decode(new Uint8Array(...)), push it, set at = i + n.",
    "Return { messages, rest: buf.slice(at) }, messages being string[].",
  ],
  fixtures: {
    twoFrames: [[2, 104, 105, 5, 116, 104, 101, 114, 101]],
    split: [[2], [104], [105, 5, 116], [104, 101, 114, 101]],
    partial: [[2, 104, 105, 5, 116, 104]],
    partialRest: [5, 116, 104],
    emptyMessage: [[0]],
    utf8: [[8, 111, 108, 195], [161, 32, 226, 136, 145]],
  },
  examples: [
    { name: "a varint cut in the middle", args: [[[130]]], expected: { messages: [], rest: [130] } },
    { name: "a 2-byte length with no payload yet", args: [[[130, 1]]], expected: { messages: [], rest: [130, 1] } },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin p2p.decodeVarint
export const decodeVarint: Decoder = (chunks) => arc.todo("p2p.decodeVarint");
// @openarc:end p2p.decodeVarint

// ───────────────────────────── handshake ─────────────────────────────
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export type HsState = { phase: "idle" | "sent" | "ready" | "failed"; version: number | null; error: string | null };
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export type HsEvent =
  | { type: "start" }
  | { type: "hello"; versions: number[] }
  | { type: "ack"; version: number }
  | { type: "reject"; reason: string };
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export type HsMessage = { type: "hello"; versions: number[] } | { type: "ack"; version: number } | { type: "reject"; reason: string };
type Handshake = (state: HsState, event: HsEvent, supported: number[]) => { state: HsState; send: HsMessage[] };

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const handshakeSpec = arc.defineRegion<Handshake>({
  id: "p2p.handshake",
  intent: [
    "One step of the handshake state machine; pure. start (from idle): phase sent, send hello with our supported versions.",
    "hello (idle or sent): the highest version both sides support -> phase ready with it, send ack; none in common -> phase failed, error 'version-mismatch', send reject 'version-mismatch'.",
    "ack (sent): a version we support -> ready; otherwise failed + reject, as for hello. reject (any phase but failed): failed with its reason, send nothing.",
    "Anything else (an ack while idle, any event once ready or failed) changes nothing and sends nothing.",
  ],
  examples: [
    { name: "start sends hello", args: [{ phase: "idle", version: null, error: null }, { type: "start" }, [1, 2]], expected: { state: { phase: "sent", version: null, error: null }, send: [{ type: "hello", versions: [1, 2] }] } },
    { name: "hello picks the highest common version", args: [{ phase: "idle", version: null, error: null }, { type: "hello", versions: [1, 2, 3] }, [2, 1]], expected: { state: { phase: "ready", version: 2, error: null }, send: [{ type: "ack", version: 2 }] } },
    { name: "rejects a version mismatch", args: [{ phase: "sent", version: null, error: null }, { type: "hello", versions: [3] }, [1, 2]], expected: { state: { phase: "failed", version: null, error: "version-mismatch" }, send: [{ type: "reject", reason: "version-mismatch" }] } },
    { name: "an empty version list is a mismatch", args: [{ phase: "idle", version: null, error: null }, { type: "hello", versions: [] }, [1]], expected: { state: { phase: "failed", version: null, error: "version-mismatch" }, send: [{ type: "reject", reason: "version-mismatch" }] } },
    { name: "ack completes our hello", args: [{ phase: "sent", version: null, error: null }, { type: "ack", version: 1 }, [1, 2]], expected: { state: { phase: "ready", version: 1, error: null }, send: [] } },
    { name: "ack for a version we never offered", args: [{ phase: "sent", version: null, error: null }, { type: "ack", version: 7 }, [1, 2]], expected: { state: { phase: "failed", version: null, error: "version-mismatch" }, send: [{ type: "reject", reason: "version-mismatch" }] } },
    { name: "the peer rejects us", args: [{ phase: "sent", version: null, error: null }, { type: "reject", reason: "busy" }, [1]], expected: { state: { phase: "failed", version: null, error: "busy" }, send: [] } },
    { name: "ready ignores a late hello", args: [{ phase: "ready", version: 2, error: null }, { type: "hello", versions: [1] }, [1, 2]], expected: { state: { phase: "ready", version: 2, error: null }, send: [] } },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin p2p.handshake
export const handshake: Handshake = (state, event, supported) => {
  let newState: HsState = { ...state };
  let send: HsMessage[] = [];
  switch (event.type) {
      case 'start':
        if (state.phase === 'idle') {
          newState.phase = 'sent';
          send = [{ type: 'hello', versions: supported }];
        }
        break;
      case 'hello':
        if (state.phase === 'idle' || state.phase === 'sent') {
          const commonVersions = event.versions.filter(v => supported.includes(v));
          if (commonVersions.length > 0) {
            const version = Math.max(...commonVersions);
            newState.phase = 'ready';
            newState.version = version;
            send = [{ type: 'ack', version }];
          } else {
            newState.phase = 'failed';
            newState.error = 'version-mismatch';
            send = [{ type: 'reject', reason: 'version-mismatch' }];
          }
        }
        break;
      case 'ack':
        if (state.phase === 'sent') {
          if (supported.includes(event.version)) {
            newState.phase = 'ready';
            newState.version = event.version;
          } else {
            newState.phase = 'failed';
            newState.error = 'version-mismatch';
            send = [{ type: 'reject', reason: 'version-mismatch' }];
          }
        }
        break;
      case 'reject':
        if (state.phase !== 'failed') {
          newState.phase = 'failed';
          newState.error = event.reason;
        }
        break;
    }
  return { state: newState, send: send };
};
// @openarc:end p2p.handshake

// ───────────────────────────── peer table and gossip ─────────────────────────────
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export type PeerEvent = { type: "connected" | "disconnected"; peer: string };
type PeerTable = (peers: string[], event: PeerEvent, maxPeers: number) => string[];

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const peerTableSpec = arc.defineRegion<PeerTable>({
  id: "p2p.peerTable",
  intent: "The peer list after one event, sorted. connected adds the peer if it is new and the table has room (fewer than maxPeers), else nothing changes; disconnected removes it.",
  examples: [
    { args: [["b"], { type: "connected", peer: "a" }, 8], expected: ["a", "b"] },
    { name: "a full table refuses new peers", args: [["a", "b"], { type: "connected", peer: "c" }, 2], expected: ["a", "b"] },
    { name: "connecting twice keeps one entry", args: [["a"], { type: "connected", peer: "a" }, 8], expected: ["a"] },
    { args: [["a", "b"], { type: "disconnected", peer: "a" }, 8], expected: ["b"] },
    { args: [[], { type: "disconnected", peer: "x" }, 0], expected: [] },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin p2p.peerTable
export const peerTable: PeerTable = (peers, event, maxPeers) => {
  if (event.type === "connected") {
    if (!peers.includes(event.peer) && peers.length < maxPeers) {
      return [...peers, event.peer].sort();
    } else {
      return [...peers].sort();
    }
  } else if (event.type === "disconnected") {
    return peers.filter(p => p !== event.peer).sort();
  } else {
    return [...peers].sort();
  }
};
// @openarc:end p2p.peerTable

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export interface Gossip {
  id: string; // unique per message: the dedupe key
  origin: string;
  ttl: number; // hops left
  body: string;
}
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export interface PeerState {
  self: string;
  peers: string[];
  seen: string[]; // message ids already handled, most recent last, at most SEEN_LIMIT
}
/** How many message ids a peer remembers for deduplication.
 * @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette).
 */
export const SEEN_LIMIT = 256;
type OnGossip = (state: PeerState, from: string | null, msg: Gossip, fanout: number) => { state: PeerState; deliver: boolean; forward: { to: string; msg: Gossip }[] };

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const onGossipSpec = arc.defineRegion<OnGossip>({
  id: "p2p.onGossip",
  intent: [
    "One peer handles one gossip message; pure. A message id already in state.seen: no change, deliver false, forward nothing.",
    "Otherwise append the id to seen (keep the last SEEN_LIMIT), deliver true, and when msg.ttl > 0 forward a copy with ttl - 1 to at most `fanout` peers:",
    "the candidates are state.peers minus `from`, msg.origin and self, in sorted order, rotated left by (sum of the char codes of msg.id) mod their count.",
  ],
  examples: [
    {
      name: "a new message is delivered and forwarded with one hop less (152 mod 3 = 2: d first)",
      args: [{ self: "a", peers: ["b", "c", "d"], seen: [] }, null, { id: "g1", origin: "a", ttl: 2, body: "hi" }, 2],
      expected: { state: { self: "a", peers: ["b", "c", "d"], seen: ["g1"] }, deliver: true, forward: [{ to: "d", msg: { id: "g1", origin: "a", ttl: 1, body: "hi" } }, { to: "b", msg: { id: "g1", origin: "a", ttl: 1, body: "hi" } }] },
    },
    {
      name: "a duplicate is dropped",
      args: [{ self: "b", peers: ["a", "c"], seen: ["g1"] }, "a", { id: "g1", origin: "a", ttl: 1, body: "hi" }, 2],
      expected: { state: { self: "b", peers: ["a", "c"], seen: ["g1"] }, deliver: false, forward: [] },
    },
    {
      name: "ttl 0 is delivered but not forwarded",
      args: [{ self: "b", peers: ["a", "c"], seen: [] }, "a", { id: "g2", origin: "a", ttl: 0, body: "hi" }, 2],
      expected: { state: { self: "b", peers: ["a", "c"], seen: ["g2"] }, deliver: true, forward: [] },
    },
    {
      name: "never back to the sender or the origin",
      args: [{ self: "c", peers: ["a", "b", "d"], seen: [] }, "b", { id: "g1", origin: "a", ttl: 3, body: "hi" }, 5],
      expected: { state: { self: "c", peers: ["a", "b", "d"], seen: ["g1"] }, deliver: true, forward: [{ to: "d", msg: { id: "g1", origin: "a", ttl: 2, body: "hi" } }] },
    },
    { name: "fanout 0", args: [{ self: "a", peers: ["b"], seen: [] }, null, { id: "x", origin: "a", ttl: 1, body: "" }, 0], expected: { state: { self: "a", peers: ["b"], seen: ["x"] }, deliver: true, forward: [] } },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin p2p.onGossip
export const onGossip: OnGossip = (state, from, msg, fanout) => {
  if (state.seen.includes(msg.id)) {
      return { state, deliver: false, forward: [] };
    }
  const newSeen = [...state.seen, msg.id].slice(-SEEN_LIMIT);
  const newState = { ...state, seen: newSeen };
  if (msg.ttl <= 0) {
      return { state: newState, deliver: true, forward: [] };
    }
  const candidates = state.peers.filter(p => p !== from && p !== msg.origin && p !== state.self);
  const sumCharCodes = Array.from(msg.id).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const rotatedCandidates = [...candidates.slice(sumCharCodes % candidates.length), ...candidates.slice(0, sumCharCodes % candidates.length)];
  const forwardTo = rotatedCandidates.slice(0, fanout);
  const forward = forwardTo.map(peer => ({ to: peer, msg: { ...msg, ttl: msg.ttl - 1 } }));
  return { state: newState, deliver: true, forward };
};
// @openarc:end p2p.onGossip

/** The network as one peer process sees it: send to a linked peer; receive the next delivery (null when quiet).
 * @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette).
 */
export interface Transport {
  send(from: string, to: string, msg: Gossip): Promise<void>;
  next(): Promise<{ from: string; to: string; msg: Gossip } | null>;
}
/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export type BroadcastResult = { delivered: Record<string, string[]>; sent: number };
type Broadcast = (net: Transport, peers: PeerState[], origin: string, msg: Gossip, fanout: number) => Promise<BroadcastResult>;

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export const broadcastSpec = arc.defineRegion<Broadcast>({
  id: "p2p.broadcast",
  intent: [
    "Run one gossip broadcast to quiescence over the transport. The origin handles msg first (from null); after that, take deliveries from net.next() until it returns null,",
    "and each receiving peer handles its message with onGossip (unknown peers ignore it). A peer that delivers records msg.body; every forward goes out with net.send and counts as sent.",
    "delivered has every peer's id, in the order of `peers`, with the bodies it delivered.",
    "Method: states = new Map of peer.self -> peer; delivered = one [] per peer, in order; a helper handle(at, from, m) calls onGossip(state, from, m, fanout), stores r.state, pushes m.body if r.deliver, and for each f of r.forward awaits net.send(at, f.to, f.msg) and counts it. handle(origin, null, msg), then repeat handle(d.to, d.from, d.msg) until net.next() returns null.",
  ],
  examples: [
    {
      name: "3 peers, fully connected: everyone delivers exactly once",
      args: [
        { $fake: "palette.net", init: { links: [["a", "b"], ["b", "c"], ["a", "c"]] } },
        [{ self: "a", peers: ["b", "c"], seen: [] }, { self: "b", peers: ["a", "c"], seen: [] }, { self: "c", peers: ["a", "b"], seen: [] }],
        "a", { id: "g1", origin: "a", ttl: 2, body: "hello" }, 2,
      ],
      expected: { delivered: { a: ["hello"], b: ["hello"], c: ["hello"] }, sent: 4 },
      fakesAfter: { "palette.net": { log: ["a>b g1", "a>c g1", "b>c g1", "c>b g1"], dropped: 0 } },
    },
    {
      name: "a line a-b-c with ttl 1 never reaches c",
      args: [
        { $fake: "palette.net", init: { links: [["a", "b"], ["b", "c"]] } },
        [{ self: "a", peers: ["b"], seen: [] }, { self: "b", peers: ["a", "c"], seen: [] }, { self: "c", peers: ["b"], seen: [] }],
        "a", { id: "g1", origin: "a", ttl: 1, body: "hello" }, 2,
      ],
      expected: { delivered: { a: ["hello"], b: ["hello"], c: [] }, sent: 1 },
    },
    {
      name: "the same line with ttl 2 reaches c",
      args: [
        { $fake: "palette.net", init: { links: [["a", "b"], ["b", "c"]] } },
        [{ self: "a", peers: ["b"], seen: [] }, { self: "b", peers: ["a", "c"], seen: [] }, { self: "c", peers: ["b"], seen: [] }],
        "a", { id: "g1", origin: "a", ttl: 2, body: "hello" }, 2,
      ],
      expected: { delivered: { a: ["hello"], b: ["hello"], c: ["hello"] }, sent: 2 },
    },
    {
      name: "fanout bounds what the origin sends; a message already seen is not delivered again",
      args: [
        { $fake: "palette.net", init: { links: [["a", "b"], ["a", "c"], ["a", "d"], ["b", "c"], ["c", "d"]] } },
        [{ self: "a", peers: ["b", "c", "d"], seen: [] }, { self: "b", peers: ["a", "c"], seen: [] }, { self: "c", peers: ["a", "b", "d"], seen: [] }, { self: "d", peers: ["a", "c"], seen: ["g1"] }],
        "a", { id: "g1", origin: "a", ttl: 1, body: "hello" }, 1,
      ],
      expected: { delivered: { a: ["hello"], b: [], c: [], d: [] }, sent: 1 },
    },
    {
      name: "a send over a missing link is dropped by the network",
      args: [
        { $fake: "palette.net", init: { links: [] } },
        [{ self: "a", peers: ["b"], seen: [] }, { self: "b", peers: ["a"], seen: [] }],
        "a", { id: "g1", origin: "a", ttl: 1, body: "hello" }, 1,
      ],
      expected: { delivered: { a: ["hello"], b: [] }, sent: 1 },
      fakesAfter: { "palette.net": { log: [], dropped: 1 } },
    },
  ],
});

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin p2p.broadcast
export const broadcast: Broadcast = async (net, peers, origin, msg, fanout) => {
  const states = new Map<string, PeerState>();
  for (const p of peers) states.set(p.self, p);
  const delivered: Record<string, string[]> = {};
  for (const p of peers) delivered[p.self] = [];
  const handle = async (at: string, from: string | null, m: Gossip) => {
    const state = states.get(at) || { self: at, peers: [], seen: [] };
    const r = onGossip(state, from, m, fanout);
    states.set(at, r.state);
    if (r.deliver) delivered[at].push(m.body);
    for (const f of r.forward) {
      await net.send(at, f.to, f.msg);
      sent++;
    }
  };
  let sent = 0;
  await handle(origin, null, msg);
  while (true) {
    const d = await net.next();
    if (!d) break;
    await handle(d.to, d.from, d.msg);
  }
  return { delivered, sent };
};
// @openarc:end p2p.broadcast
