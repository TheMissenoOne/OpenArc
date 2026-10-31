// OpenArc palette: auth. A concept with three variants (password, API key, magic link). See README.md.
// Every effect goes through a port: the user store, the hasher (with a constant-time compare) and the clock.
// The laws are the security properties: a wrong secret is rejected, an unknown user gets the same answer as a wrong
// secret, and every attempt pays for exactly one constant-time compare (also when the user doesn't exist).
import * as arc from "open-arc";

export interface User {
  id: string;
  email: string; // stored lower-case
  passwordHash: string;
  lockedUntil: number | null; // ms since epoch
}
export interface ApiKeyRecord {
  keyId: string;
  userId: string;
  secretHash: string;
  revoked: boolean;
}
export interface MagicLinkRecord {
  tokenId: string;
  userId: string;
  secretHash: string;
  expiresAt: number; // ms since epoch
  used: boolean;
}
export interface UserStore {
  findByEmail(email: string): Promise<User | null>;
  findApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  findMagicLink(tokenId: string): Promise<MagicLinkRecord | null>;
  /** Atomically mark the link used (compare-and-set used: false -> true). True only for the one call that flipped it. */
  consumeMagicLink(tokenId: string): Promise<boolean>;
  recordFailure(userId: string): Promise<void>;
}
export interface Hasher {
  /** A valid stored hash in this adapter's own format (algorithm, salt, cost) whose secret nobody knows: what an attempt
   *  hashes and compares against when there is no stored hash, so an unknown user costs the same as a wrong secret. */
  readonly dummyHash: string;
  /** Hash `secret` with the parameters (algorithm, salt, cost) of `like`, an existing stored hash: equal secrets give equal hashes. */
  hash(secret: string, like: string): Promise<string>;
  /** Constant-time string comparison (node:crypto timingSafeEqual on equal-length buffers). */
  equal(a: string, b: string): boolean;
}
export interface Clock {
  now(): number;
}
export interface AuthPorts {
  users: UserStore;
  hasher: Hasher;
  clock: Clock;
}
export type AuthResult = { ok: true; userId: string } | { ok: false; reason: "invalid" | "locked" | "expired" };
/** The concept's interface: every variant is a Strategy of its own credential type. */
export type Strategy<C> = (cred: C, ports: AuthPorts) => Promise<AuthResult>;
export type PasswordCred = { email: string; password: string };
export type ApiKeyCred = { apiKey: string }; // "<keyId>.<secret>"
export type MagicLinkCred = { token: string }; // "<tokenId>.<secret>"

export const authConcept = arc.defineConcept({
  id: "auth",
  interface: "Strategy",
  intent: [
    "Authenticate one credential against stored users. Every strategy returns an AuthResult and never throws for bad input.",
    "An unknown user gets the same answer as a wrong secret, and every attempt runs exactly one constant-time compare (ports.hasher.equal), against ports.hasher.dummyHash when there is no stored hash.",
    "Never put a secret in the result.",
  ],
  laws: [
    { name: "valid credential authenticates", args: ["$fixture:valid", "$fixture:ports"], expected: { ok: true, userId: "u1" } },
    { name: "wrong secret is rejected", args: ["$fixture:wrong", "$fixture:ports"], expected: { ok: false, reason: "invalid" } },
    { name: "unknown user is the same error as a wrong secret", args: ["$fixture:unknown", "$fixture:ports"], expected: { ok: false, reason: "invalid" } },
    { name: "constant-time compare used", args: ["$fixture:valid", "$fixture:ports"], expected: { ok: true, userId: "u1" }, fakesAfter: { "palette.auth": { compares: 1 } } },
    { name: "an unknown user still costs one compare", args: ["$fixture:unknown", "$fixture:ports"], expected: { ok: false, reason: "invalid" }, fakesAfter: { "palette.auth": { compares: 1 } } },
  ],
});

// ── auth.splitToken ───────────────────────────────────────────── a helper the token variants share
type SplitToken = (token: string) => [string, string] | null;

export const splitTokenSpec = arc.defineRegion<SplitToken>({
  id: "auth.splitToken",
  intent: "Split '<id>.<secret>' at the FIRST dot. Null when there is no dot, or the id or the secret is empty.",
  examples: [
    { args: ["k1.s3cret"], expected: ["k1", "s3cret"] },
    { name: "only the first dot splits", args: ["k1.a.b"], expected: ["k1", "a.b"] },
    { args: ["nodot"], expected: null },
    { args: [""], expected: null },
    { args: [".s"], expected: null },
    { args: ["k1."], expected: null },
  ],
});

// @openarc:begin auth.splitToken
export const splitToken: SplitToken = (token) => {
  const i = token.indexOf(".");
  if (i <= 0 || i === token.length - 1) return null;
  return [token.slice(0, i), token.slice(i + 1)];
};
// @openarc:end auth.splitToken

// ── auth.password ─────────────────────────────────────────────── variant, written as a sketch
export const passwordSpec = arc.defineRegion<Strategy<PasswordCred>>({
  id: "auth.password",
  concept: "auth",
  intent: "Email and password. Emails compare case-insensitively and ignore surrounding spaces. A locked account is reported only after the password matched.",
  calls: ["ports.users.recordFailure", "ports.clock.now"],
  fixtures: {
    ports: { $fake: "palette.auth", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil: null }], now: 1000 } },
    valid: { email: "ana@x.io", password: "secret" },
    wrong: { email: "ana@x.io", password: "nope" },
    unknown: { email: "bob@x.io", password: "secret" },
  },
  examples: [
    { name: "email is case- and space-insensitive", args: [{ email: " Ana@X.io ", password: "secret" }, { $fake: "palette.auth", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil: null }], now: 1000 } }], expected: { ok: true, userId: "u1" } },
    { name: "empty password", args: [{ email: "ana@x.io", password: "" }, { $fake: "palette.auth", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil: null }], now: 1000 } }], expected: { ok: false, reason: "invalid" } },
    { name: "locked account", args: [{ email: "ana@x.io", password: "secret" }, { $fake: "palette.auth", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil: 5000 }], now: 1000 } }], expected: { ok: false, reason: "locked" } },
    {
      name: "a wrong password on a locked account is just invalid, and recorded",
      args: [{ email: "ana@x.io", password: "nope" }, { $fake: "palette.auth", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil: 5000 }], now: 1000, track: ["failures"] } }],
      expected: { ok: false, reason: "invalid" },
      fakesAfter: { "palette.auth": { compares: 1, failures: ["u1"] } },
    },
    { name: "an expired lock is ignored", args: [{ email: "ana@x.io", password: "secret" }, { $fake: "palette.auth", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil: 500 }], now: 1000 } }], expected: { ok: true, userId: "u1" } },
  ],
  sketch: async (cred, ports) => {
    const email = arc.hole<string>("cred.email trimmed and lower-cased");
    const user = await ports.users.findByEmail(email);
    const stored = user?.passwordHash ?? ports.hasher.dummyHash;
    const match = ports.hasher.equal(await ports.hasher.hash(cred.password, stored), stored);
    if (user === null || !match) {
      arc.hole("if the user exists, record the failure for user.id");
      return { ok: false, reason: "invalid" };
    }
    if (arc.hole<boolean>("the account is locked: user.lockedUntil is set and later than ports.clock.now()")) return { ok: false, reason: "locked" };
    return { ok: true, userId: user.id };
  },
});

// @openarc:begin auth.password
export const password: Strategy<PasswordCred> = async (cred, ports) => {
  const email = (cred.email.trim().toLowerCase());
  const user = await ports.users.findByEmail(email);
  const stored = user?.passwordHash ?? ports.hasher.dummyHash;
  const match = ports.hasher.equal(await ports.hasher.hash(cred.password, stored), stored);
  if (user === null || !match) {
    if (user !== null) await ports.users.recordFailure(user.id);
    return { ok: false, reason: "invalid" };
  }
  if ((user.lockedUntil !== null && user.lockedUntil > ports.clock.now())) return { ok: false, reason: "locked" };
  return { ok: true, userId: user.id };
};
// @openarc:end auth.password

// ── auth.apiKey ───────────────────────────────────────────────── variant, written as prose
export const apiKeySpec = arc.defineRegion<Strategy<ApiKeyCred>>({
  id: "auth.apiKey",
  concept: "auth",
  intent: [
    "cred.apiKey is '<keyId>.<secret>' (splitToken). Look the key up with ports.users.findApiKey(keyId).",
    "Hash the secret with ports.hasher.hash(secret, record.secretHash) and compare once with ports.hasher.equal; when the key is malformed, unknown or revoked, hash and compare against ports.hasher.dummyHash instead.",
    "Malformed, unknown, revoked or wrong: { ok: false, reason: 'invalid' }; a wrong secret for a live key records a failure for its userId. Locks don't apply to API keys.",
  ],
  calls: ["ports.users.findApiKey", "ports.hasher.hash", "ports.hasher.equal", "ports.users.recordFailure"],
  fixtures: {
    ports: { $fake: "palette.auth", init: { apiKeys: [{ keyId: "k1", userId: "u1", secretHash: "h:s3cret", revoked: false }], now: 1000 } },
    valid: { apiKey: "k1.s3cret" },
    wrong: { apiKey: "k1.guess" },
    unknown: { apiKey: "k9.s3cret" },
  },
  examples: [
    { name: "malformed key", args: [{ apiKey: "" }, { $fake: "palette.auth", init: { apiKeys: [{ keyId: "k1", userId: "u1", secretHash: "h:s3cret", revoked: false }], now: 1000 } }], expected: { ok: false, reason: "invalid" }, fakesAfter: { "palette.auth": { compares: 1 } } },
    { name: "revoked key", args: [{ apiKey: "k2.old" }, { $fake: "palette.auth", init: { apiKeys: [{ keyId: "k2", userId: "u1", secretHash: "h:old", revoked: true }], now: 1000 } }], expected: { ok: false, reason: "invalid" } },
    {
      name: "a wrong secret is recorded for the key's user",
      args: [{ apiKey: "k1.guess" }, { $fake: "palette.auth", init: { apiKeys: [{ keyId: "k1", userId: "u1", secretHash: "h:s3cret", revoked: false }], now: 1000, track: ["failures"] } }],
      expected: { ok: false, reason: "invalid" },
      fakesAfter: { "palette.auth": { compares: 1, failures: ["u1"] } },
    },
  ],
});

// @openarc:begin auth.apiKey
export const apiKey: Strategy<ApiKeyCred> = async (cred, ports) => {
  const parts = splitToken(cred.apiKey);
  const record = parts ? await ports.users.findApiKey(parts[0]) : null;
  const live = record !== null && !record.revoked ? record : null;
  const stored = live?.secretHash ?? ports.hasher.dummyHash;
  const match = ports.hasher.equal(await ports.hasher.hash(parts?.[1] ?? "", stored), stored);
  if (live === null) return { ok: false, reason: "invalid" };
  if (!match) {
    await ports.users.recordFailure(live.userId);
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, userId: live.userId };
};
// @openarc:end auth.apiKey

// ── auth.magicLink ────────────────────────────────────────────── variant, written as a sketch
export const magicLinkSpec = arc.defineRegion<Strategy<MagicLinkCred>>({
  id: "auth.magicLink",
  concept: "auth",
  intent: "A one-time sign-in link. An expired link says so only when its secret matched; a used link is invalid. Only the request whose atomic consumeMagicLink claim succeeds signs in: a link authenticates at most once, even under concurrent requests.",
  calls: ["ports.clock.now", "ports.users.consumeMagicLink"],
  fixtures: {
    ports: { $fake: "palette.auth", init: { links: [{ tokenId: "t1", userId: "u1", secretHash: "h:abc", expiresAt: 2000, used: false }], now: 1000 } },
    valid: { token: "t1.abc" },
    wrong: { token: "t1.abd" },
    unknown: { token: "t9.abc" },
  },
  examples: [
    { name: "expired link", args: [{ token: "t2.abc" }, { $fake: "palette.auth", init: { links: [{ tokenId: "t2", userId: "u1", secretHash: "h:abc", expiresAt: 500, used: false }], now: 1000 } }], expected: { ok: false, reason: "expired" } },
    { name: "an expired link with a wrong secret is just invalid", args: [{ token: "t2.x" }, { $fake: "palette.auth", init: { links: [{ tokenId: "t2", userId: "u1", secretHash: "h:abc", expiresAt: 500, used: false }], now: 1000 } }], expected: { ok: false, reason: "invalid" } },
    { name: "a used link is invalid", args: [{ token: "t3.abc" }, { $fake: "palette.auth", init: { links: [{ tokenId: "t3", userId: "u1", secretHash: "h:abc", expiresAt: 2000, used: true }], now: 1000 } }], expected: { ok: false, reason: "invalid" } },
    {
      name: "a valid link is consumed",
      args: [{ token: "t1.abc" }, { $fake: "palette.auth", init: { links: [{ tokenId: "t1", userId: "u1", secretHash: "h:abc", expiresAt: 2000, used: false }], now: 1000, track: ["consumed"] } }],
      expected: { ok: true, userId: "u1" },
      fakesAfter: { "palette.auth": { compares: 1, consumed: ["t1"] } },
    },
    { name: "malformed token", args: [{ token: "" }, { $fake: "palette.auth", init: { links: [], now: 1000 } }], expected: { ok: false, reason: "invalid" } },
    {
      name: "a link a concurrent request claimed first is invalid",
      args: [{ token: "t1.abc" }, { $fake: "palette.auth", init: { links: [{ tokenId: "t1", userId: "u1", secretHash: "h:abc", expiresAt: 2000, used: false }], now: 1000, claimedConcurrently: ["t1"], track: ["consumed"] } }],
      expected: { ok: false, reason: "invalid" },
      fakesAfter: { "palette.auth": { compares: 1, consumed: [] } },
    },
  ],
  sketch: async (cred, ports) => {
    const [tokenId, secret] = splitToken(cred.token) ?? ["", ""];
    const link = tokenId ? await ports.users.findMagicLink(tokenId) : null;
    const stored = link !== null && !link.used ? link.secretHash : ports.hasher.dummyHash;
    const match = ports.hasher.equal(await ports.hasher.hash(secret, stored), stored);
    if (link === null || link.used || !match) return { ok: false, reason: "invalid" };
    if (arc.hole<boolean>("the link has expired: link.expiresAt is not later than ports.clock.now()")) return { ok: false, reason: "expired" };
    if (!(await ports.users.consumeMagicLink(tokenId))) return { ok: false, reason: "invalid" }; // the atomic claim: one sign-in per link
    return { ok: true, userId: link.userId };
  },
});

// @openarc:begin auth.magicLink
export const magicLink: Strategy<MagicLinkCred> = async (cred, ports) => {
  const [tokenId, secret] = splitToken(cred.token) ?? ["", ""];
  const link = tokenId ? await ports.users.findMagicLink(tokenId) : null;
  const stored = link !== null && !link.used ? link.secretHash : ports.hasher.dummyHash;
  const match = ports.hasher.equal(await ports.hasher.hash(secret, stored), stored);
  if (link === null || link.used || !match) return { ok: false, reason: "invalid" };
  if ((link.expiresAt <= ports.clock.now())) return { ok: false, reason: "expired" };
  if (!(await ports.users.consumeMagicLink(tokenId))) return { ok: false, reason: "invalid" }; // the atomic claim: one sign-in per link
  return { ok: true, userId: link.userId };
};
// @openarc:end auth.magicLink
