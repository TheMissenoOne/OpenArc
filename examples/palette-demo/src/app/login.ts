// A login flow on top of the auth palette: auth.password decides, this region turns its answer into a session or a
// message. Written as a sketch: the model fills one expression.
import * as arc from "open-arc";
import * as auth from "../palette/auth.ts";

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}
export interface SessionStore {
  newToken(): string;
  insert(s: Session): Promise<void>;
}
export interface AppPorts extends auth.AuthPorts {
  sessions: SessionStore;
}
export type LoginResult = { ok: true; token: string; expiresAt: number } | { ok: false; error: string };
export const SESSION_MS = 3_600_000;

type Login = (cred: auth.PasswordCred, ports: AppPorts) => Promise<LoginResult>;

export const loginSpec = arc.defineRegion<Login>({
  id: "app.login",
  intent: "Never tell the user whether the email exists.",
  examples: [
    {
      name: "valid: a session for an hour",
      args: [{ email: "Ana@x.io", password: "secret" }, { $fake: "demo.app", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil: null }], now: 1000 } }],
      expected: { ok: true, token: "tok-1", expiresAt: 3601000 },
      fakesAfter: { "demo.app": { sessions: [{ token: "tok-1", userId: "u1", expiresAt: 3601000 }] } },
    },
    {
      name: "wrong password",
      args: [{ email: "ana@x.io", password: "nope" }, { $fake: "demo.app", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil: null }], now: 1000 } }],
      expected: { ok: false, error: "Wrong email or password." },
      fakesAfter: { "demo.app": { sessions: [] } },
    },
    {
      name: "an unknown email gets the same message",
      args: [{ email: "", password: "secret" }, { $fake: "demo.app", init: { users: [], now: 1000 } }],
      expected: { ok: false, error: "Wrong email or password." },
    },
    {
      name: "locked",
      args: [{ email: "ana@x.io", password: "secret" }, { $fake: "demo.app", init: { users: [{ id: "u1", email: "ana@x.io", passwordHash: "h:secret", lockedUntil: 9000 }], now: 1000 } }],
      expected: { ok: false, error: "Account locked. Try again later." },
    },
  ],
  sketch: async (cred, ports) => {
    const r = await auth.password(cred, ports);
    if (!r.ok) return { ok: false, error: arc.hole<string>("the message for r.reason: 'locked' -> 'Account locked. Try again later.', anything else -> 'Wrong email or password.'") };
    const session = { token: ports.sessions.newToken(), userId: r.userId, expiresAt: ports.clock.now() + SESSION_MS };
    await ports.sessions.insert(session);
    return { ok: true, token: session.token, expiresAt: session.expiresAt };
  },
});

// @openarc:begin app.login
export const login: Login = (cred, ports) => arc.todo("app.login");
// @openarc:end app.login
