// Fake AuthPorts for the auth palette (src/palette/auth.ts). Stored hashes are "h:<secret>" and hash() ignores its
// parameters, so hash(s, like) === "h:" + s. equal() counts every constant-time compare.
// init: { users?, apiKeys?, links?, now, track?: ("failures" | "consumed")[] }
// snapshot(): { compares } plus the tracked lists, so a law can state exactly what it checks.
import { defineFake } from "open-arc";
import type { ApiKeyRecord, AuthPorts, MagicLinkRecord, User } from "../../src/palette/auth.ts";

export default defineFake<AuthPorts>((init) => {
  const i = (init ?? {}) as unknown as { users?: User[]; apiKeys?: ApiKeyRecord[]; links?: MagicLinkRecord[]; now?: number; track?: string[] };
  const failures: string[] = [];
  const consumed: string[] = [];
  let compares = 0;
  const instance: AuthPorts = {
    users: {
      findByEmail: async (email) => i.users?.find((u) => u.email === email) ?? null,
      findApiKey: async (keyId) => i.apiKeys?.find((k) => k.keyId === keyId) ?? null,
      findMagicLink: async (tokenId) => i.links?.find((l) => l.tokenId === tokenId) ?? null,
      consumeMagicLink: async (tokenId) => void consumed.push(tokenId),
      recordFailure: async (userId) => void failures.push(userId),
    },
    hasher: {
      hash: async (secret) => `h:${secret}`,
      equal: (a, b) => (compares++, a === b),
    },
    clock: { now: () => i.now ?? 0 },
  };
  const track = new Set(i.track ?? []);
  return { instance, snapshot: () => ({ compares, ...(track.has("failures") ? { failures } : {}), ...(track.has("consumed") ? { consumed } : {}) }) };
});
