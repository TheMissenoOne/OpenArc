/** @jsxImportSource open-arc/ui */
// OpenArc palette: a login page as a UI structure spec (a React component; see README.md). The structure is checked in a
// rendered DOM (jsdom, from the project's devDependencies): labelled fields, an alert for errors, a submit button, and
// the wiring of the form to props.onLogin. Wire onLogin to auth.password at the composition root (an adapter that turns
// its AuthResult into a message, like examples/palette-demo's app.login).
import * as arc from "open-arc";
import { ErrorText, Field, Form, Submit } from "open-arc/ui";
import type { PasswordCred } from "./auth.ts";

export type LoginOutcome = { ok: true } | { ok: false; error: string };
export type LoginPageProps = {
  onLogin: (cred: PasswordCred) => Promise<LoginOutcome>;
  onSuccess: (result: LoginOutcome) => void;
};
export type LoginPageFn = (props: LoginPageProps) => unknown;

export const loginPageSpec = arc.defineRegion<LoginPageFn>({
  id: "ui.loginPage",
  symbol: "LoginPage",
  intent: "While onLogin is pending, disable the button and show busyText. A failed result shows its error and keeps what was typed; a new attempt clears the old error.",
  ui: (props) => (
    <Form title="Sign in" onSubmit={props.onLogin} onSuccess={props.onSuccess}>
      <Field name="email" type="email" label="Email" required autoComplete="username" />
      <Field name="password" secret label="Password" required autoComplete="current-password" />
      {/* the failure message from onLogin */}
      <ErrorText />
      <Submit busyText="Signing in…">Sign in</Submit>
    </Form>
  ),
  examples: [
    {
      name: "a wrong password shows the error and keeps the form",
      args: [{ onLogin: { $fake: "action#onLogin", init: { returns: [{ ok: false, error: "Wrong email or password." }] } }, onSuccess: { $fake: "action#onSuccess" } }],
      script: [{ fill: { label: "Email", value: "ana@x.io" } }, { fill: { label: "Password", value: "nope" } }, { click: { role: "button", name: "Sign in" } }],
      dom: { text: ["Wrong email or password."], enabled: [{ role: "button", name: "Sign in" }] },
      fakesAfter: { "action#onLogin": { calls: [[{ email: "ana@x.io", password: "nope" }]] }, "action#onSuccess": { calls: [] } },
    },
    {
      name: "success calls onSuccess with the result",
      args: [{ onLogin: { $fake: "action#onLogin", init: { returns: [{ ok: true }] } }, onSuccess: { $fake: "action#onSuccess" } }],
      script: [{ fill: { label: "Email", value: "ana@x.io" } }, { fill: { label: "Password", value: "secret" } }, { click: { role: "button", name: "Sign in" } }],
      dom: { notText: ["Wrong email or password."] },
      fakesAfter: { "action#onLogin": { calls: [[{ email: "ana@x.io", password: "secret" }]] }, "action#onSuccess": { calls: [[{ ok: true }]] } },
    },
    {
      name: "a second attempt replaces the error",
      args: [{ onLogin: { $fake: "action#onLogin", init: { returns: [{ ok: false, error: "Wrong email or password." }, { ok: false, error: "Account locked. Try again later." }] } }, onSuccess: { $fake: "action#onSuccess" } }],
      script: [{ fill: { label: "Email", value: "ana@x.io" } }, { fill: { label: "Password", value: "x" } }, { click: { role: "button", name: "Sign in" } }, { click: { role: "button", name: "Sign in" } }],
      dom: { text: ["Account locked. Try again later."], notText: ["Wrong email or password."] },
    },
  ],
});
