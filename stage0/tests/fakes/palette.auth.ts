// Fake AuthPorts for the auth palette (src/palette/auth.ts). Stored hashes are "h:<secret>" and hash() ignores its
// parameters, so hash(s, like) === "h:" + s. equal() counts every constant-time compare.
// Links behave like rows in a store: findMagicLink returns a snapshot, consumeMagicLink is an atomic compare-and-set
// (used: false -> true) that is true only for the call that flipped it, and it records that winning claim.
// init: { users?, apiKeys?, links?, now, track?: ("failures" | "consumed")[], claimedConcurrently?: tokenId[] }
// claimedConcurrently: another request claims these links right after this one reads them (the lost race).
// snapshot(): { compares } plus the tracked lists, so a law can state exactly what it checks.
import { defineFake } from "open-arc";
import type { ApiKeyRecord, AuthPorts, MagicLinkRecord, User } from "../../src/palette/auth.ts";

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
export default defineFake<AuthPorts>((init) => {
  const i = (init ?? {}) as unknown as { users?: User[]; apiKeys?: ApiKeyRecord[]; links?: MagicLinkRecord[]; now?: number; track?: string[]; claimedConcurrently?: string[] };
  const links = structuredClone(i.links ?? []); // a copy: consuming must not touch the example's init
  const failures: string[] = [];
  const consumed: string[] = [];
  let compares = 0;
  const instance: AuthPorts = {
    users: {
      findByEmail: async (email) => i.users?.find((u) => u.email === email) ?? null,
      findApiKey: async (keyId) => i.apiKeys?.find((k) => k.keyId === keyId) ?? null,
      findMagicLink: async (tokenId) => {
        const link = links.find((l) => l.tokenId === tokenId);
        if (!link) return null;
        const seen = { ...link };
        if (i.claimedConcurrently?.includes(tokenId)) link.used = true;
        return seen;
      },
      consumeMagicLink: async (tokenId) => {
        const link = links.find((l) => l.tokenId === tokenId);
        if (!link || link.used) return false;
        link.used = true;
        consumed.push(tokenId);
        return true;
      },
      recordFailure: async (userId) => void failures.push(userId),
    },
    hasher: {
      dummyHash: "$dummy$", // never "h:<secret>", so nothing matches it
      hash: async (secret) => `h:${secret}`,
      equal: (a, b) => (compares++, a === b),
    },
    clock: { now: () => i.now ?? 0 },
  };
  const track = new Set(i.track ?? []);
  return { instance, snapshot: () => ({ compares, ...(track.has("failures") ? { failures } : {}), ...(track.has("consumed") ? { consumed } : {}) }) };
});
