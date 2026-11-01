// The loginPage palette component (React). Its spec, with the structure the DOM checks verify, is loginPage.spec.tsx.
// Type-checked and run in a DOM by tests/ui.check.ts (it needs react's types, so stage0's own tsconfig skips this file).
import * as arc from "open-arc";
import { useState } from "react";
import type { LoginPageFn } from "./loginPage.spec.tsx";

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin ui.loginPage
export const LoginPage: LoginPageFn = (props) => {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: { preventDefault(): void; currentTarget: HTMLFormElement }) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    const result = await props.onLogin({ email: String(data.get("email") ?? ""), password: String(data.get("password") ?? "") }).finally(() => setBusy(false)); // a rejection re-enables the button too
    if (result.ok) props.onSuccess(result);
    else setError(result.error);
  };
  return (
    <form onSubmit={onSubmit}>
      <h2>Sign in</h2>
      <label htmlFor="login-email">Email</label>
      <input id="login-email" name="email" type="email" required autoComplete="username" />
      <label htmlFor="login-password">Password</label>
      <input id="login-password" name="password" type="password" required autoComplete="current-password" />
      <p role="alert">{error}</p>
      <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
};
// @openarc:end ui.loginPage
