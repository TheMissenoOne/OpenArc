// Fake AppPorts for src/app/login.ts: the palette's auth fake plus a session store. Tokens are tok-1, tok-2, …
// init: the palette.auth init (users, now, …). snapshot(): { sessions }.
import { defineFake, type Json } from "open-arc";
import authFake from "./palette.auth.ts";
import type { AppPorts, Session } from "../../src/app/login.ts";

export default defineFake<AppPorts>((init) => {
  const auth = authFake(init).instance;
  const sessions: Session[] = [];
  let n = 0;
  const instance: AppPorts = { ...auth, sessions: { newToken: () => `tok-${++n}`, insert: async (s) => void sessions.push(s) } };
  return { instance, snapshot: () => ({ sessions: sessions as unknown as Json }) };
});
