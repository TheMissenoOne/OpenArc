import * as arc from "open-arc";

/** What an authentication strategy answers (the palette's auth.password returns this). */
export type AuthResult = { ok: true; userId: string } | { ok: false; reason: "invalid" | "locked" | "unknown" };
/** What the login form shows. */
export type LoginOutcome = { ok: true } | { ok: false; error: string };

/**
 * The message the login form shows for an auth result. "invalid" and "unknown" get the same text,
 * "Wrong email or password.", so the page doesn't reveal which emails exist; "locked" is
 * "Account locked. Try again later."
 */
export function toOutcome(r: AuthResult): LoginOutcome {
  return arc.todo();
}

// A same-file test: allowed, and kept next to the adapter it checks.
arc.test(toOutcome, "unknown and invalid look the same", (f, expect) => {
  expect(f({ ok: false, reason: "unknown" })).toEqual(f({ ok: false, reason: "invalid" }));
  expect(f({ ok: false, reason: "invalid" })).toEqual({ ok: false, error: "Wrong email or password." });
  expect(f({ ok: false, reason: "locked" })).toEqual({ ok: false, error: "Account locked. Try again later." });
  expect(f({ ok: true, userId: "u1" })).toEqual({ ok: true });
});
