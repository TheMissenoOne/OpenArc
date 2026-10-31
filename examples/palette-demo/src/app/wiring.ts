// The composition root (hand-written, not a region): the palette's login page gets app.login, which runs
// auth.password and opens a session, as its onLogin.
import { login, type AppPorts } from "./login.ts";
import type { LoginPageProps } from "../palette/loginPage.spec.tsx";

export const loginPageProps = (ports: AppPorts, onSignedIn: (token: string) => void): LoginPageProps => ({
  onLogin: (cred) => login(cred, ports),
  onSuccess: (result) => {
    if (result.ok && "token" in result) onSignedIn(String(result.token));
  },
});
