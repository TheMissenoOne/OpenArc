// The loginPage palette component (React). Its spec, with the structure the DOM checks verify, is loginPage.spec.tsx.
// Type-checked and run in a DOM by tests/ui.check.ts (it needs react's types, so stage0's own tsconfig skips this file).
import * as arc from "open-arc";
import { useState } from "react";
import type { LoginPageFn } from "./loginPage.spec.tsx";

/** @deprecated Bundled palette is deprecated and frozen since 0.9.0; write your own concepts (see Palette wiki: Building your own palette). */
// @openarc:begin ui.loginPage
export const LoginPage: LoginPageFn = (props) => arc.todo("ui.loginPage");
// @openarc:end ui.loginPage
