// OpenArc palette: a peer-to-peer protocol. Message framing (a concept with two variants), a handshake state machine
// with version negotiation, a bounded peer table, and gossip (bounded fanout, dedupe by message id, TTL).
// See README.md. Bytes are number[] (0..255) so examples stay JSON. The network is a port (Transport); the fake
// network in tests/fakes/palette.net.ts connects N peers, so multi-peer examples run deterministically in the sandbox.
import * as arc from "open-arc";

// ───────────────────────────── framing ─────────────────────────────
/** A decoded stream: every complete message, and the bytes of an incomplete trailing frame. */
export type Decoded = { messages: string[]; rest: number[] };
/** The framing concept's interface: decode a byte stream that arrives in chunks. */
export type Decoder = (chunks: number[][]) => Decoded;

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

export const encodeLengthPrefixedSpec = arc.defineRegion<Encode>({
  id: "p2p.encodeLengthPrefixed",
  intent: "UTF-8 bytes of message (TextEncoder), prefixed with their count as a 4-byte unsigned big-endian integer.",
  examples: [
    { args: ["hi"], expected: [0, 0, 0, 2, 104, 105] },
    { args: [""], expected: [0, 0, 0, 0] },
    { args: ["olá ∑"], expected: [0, 0, 0, 8, 111, 108, 195, 161, 32, 226, 136, 145] },
  ],
});

// @openarc:begin p2p.encodeLengthPrefixed
export const encodeLengthPrefixed: Encode = (message) => arc.todo("p2p.encodeLengthPrefixed");
// @openarc:end p2p.encodeLengthPrefixed

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

// @openarc:begin p2p.decodeLengthPrefixed
export const decodeLengthPrefixed: Decoder = (chunks) => arc.todo("p2p.decodeLengthPrefixed");
// @openarc:end p2p.decodeLengthPrefixed

// ── p2p.encodeVarint / p2p.decodeVarint ───────────────────────── unsigned LEB128 length
export const encodeVarintSpec = arc.defineRegion<Encode>({
  id: "p2p.encodeVarint",
  intent: "UTF-8 bytes of message (TextEncoder), prefixed with their count as an unsigned LEB128 varint (7 bits per byte, low group first, high bit = more).",
  examples: [
    { args: ["hi"], expected: [2, 104, 105] },
    { args: [""], expected: [0] },
    { name: "a 2-byte length", args: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], expected: [128, 1, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97, 97] },
  ],
});

// @openarc:begin p2p.encodeVarint
export const encodeVarint: Encode = (message) => arc.todo("p2p.encodeVarint");
// @openarc:end p2p.encodeVarint

export const decodeVarintSpec = arc.defineRegion<Decoder>({
  id: "p2p.decodeVarint",
  concept: "framing",
  intent: "The prefix is an unsigned LEB128 varint (at most 5 bytes).",
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

// @openarc:begin p2p.decodeVarint
export const decodeVarint: Decoder = (chunks) => arc.todo("p2p.decodeVarint");
// @openarc:end p2p.decodeVarint

// ───────────────────────────── handshake ─────────────────────────────
export type HsState = { phase: "idle" | "sent" | "ready" | "failed"; version: number | null; error: string | null };
export type HsEvent =
  | { type: "start" }
  | { type: "hello"; versions: number[] }
  | { type: "ack"; version: number }
  | { type: "reject"; reason: string };
export type HsMessage = { type: "hello"; versions: number[] } | { type: "ack"; version: number } | { type: "reject"; reason: string };
type Handshake = (state: HsState, event: HsEvent, supported: number[]) => { state: HsState; send: HsMessage[] };

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

// @openarc:begin p2p.handshake
export const handshake: Handshake = (state, event, supported) => arc.todo("p2p.handshake");
// @openarc:end p2p.handshake

// ───────────────────────────── peer table and gossip ─────────────────────────────
export type PeerEvent = { type: "connected" | "disconnected"; peer: string };
type PeerTable = (peers: string[], event: PeerEvent, maxPeers: number) => string[];

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

// @openarc:begin p2p.peerTable
export const peerTable: PeerTable = (peers, event, maxPeers) => arc.todo("p2p.peerTable");
// @openarc:end p2p.peerTable

export interface Gossip {
  id: string; // unique per message: the dedupe key
  origin: string;
  ttl: number; // hops left
  body: string;
}
export interface PeerState {
  self: string;
  peers: string[];
  seen: string[]; // message ids already handled, most recent last, at most SEEN_LIMIT
}
/** How many message ids a peer remembers for deduplication. */
export const SEEN_LIMIT = 256;
type OnGossip = (state: PeerState, from: string | null, msg: Gossip, fanout: number) => { state: PeerState; deliver: boolean; forward: { to: string; msg: Gossip }[] };

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

// @openarc:begin p2p.onGossip
export const onGossip: OnGossip = (state, from, msg, fanout) => arc.todo("p2p.onGossip");
// @openarc:end p2p.onGossip

/** The network as one peer process sees it: send to a linked peer; receive the next delivery (null when quiet). */
export interface Transport {
  send(from: string, to: string, msg: Gossip): Promise<void>;
  next(): Promise<{ from: string; to: string; msg: Gossip } | null>;
}
export type BroadcastResult = { delivered: Record<string, string[]>; sent: number };
type Broadcast = (net: Transport, peers: PeerState[], origin: string, msg: Gossip, fanout: number) => Promise<BroadcastResult>;

export const broadcastSpec = arc.defineRegion<Broadcast>({
  id: "p2p.broadcast",
  intent: [
    "Run one gossip broadcast to quiescence over the transport. The origin handles msg first (from null); after that, take deliveries from net.next() until it returns null,",
    "and each receiving peer handles its message with onGossip (unknown peers ignore it). A peer that delivers records msg.body; every forward goes out with net.send and counts as sent.",
    "delivered has every peer's id, in the order of `peers`, with the bodies it delivered.",
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

// @openarc:begin p2p.broadcast
export const broadcast: Broadcast = (net, peers, origin, msg, fanout) => arc.todo("p2p.broadcast");
// @openarc:end p2p.broadcast
