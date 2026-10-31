// UI structure specs (SPEC §2.6), no model. Run: node tests/ui.check.ts
// 1. The `ui:` JSX in a *.spec.tsx is read statically into a tree; spreads, child expressions (.map, conditionals),
//    computed attributes and words outside the vocabulary are E010. Scaffolding puts the region in the sibling .tsx.
// 2. The package carries the structure and what its words mean; react is an allowed import.
// 3. Without `"ui": {"dom": "jsdom"}`, or without jsdom installed, a UI region is OARC-E092 before any model call.
// 4. With the DOM installed in tests/fixtures/ui (npm i there; skipped otherwise): a real compile through this OS's
//    sandbox against a fake Ollama. A miswired component fails the derived wiring example, an unlabelled one the
//    accessibility check, and the palette's hand-written LoginPage passes and is committed.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompileRequest, Ports } from "../src/types.ts";
import fakePorts from "./fakes/ports.memory.ts";
import * as engine from "../src/engine.ts";
import { run } from "../src/compile.ts";
import { pendingCopy } from "../tools/palette.ts";

const root = process.cwd();
const req: CompileRequest = { root, ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 8192 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 2 ** 32, cpuSeconds: 10 } };
const TAGS = JSON.stringify({ models: [{ name: "qwen3.5:9b", digest: "d1" }] });
const SPEC = readFileSync(join(root, "src/palette/loginPage.spec.tsx"), "utf8").replaceAll("\r\n", "\n"); // a Windows checkout may be CRLF
const AUTH = readFileSync(join(root, "src/palette/auth.ts"), "utf8").replaceAll("\r\n", "\n"); // a Windows checkout may be CRLF
const COMPONENT = readFileSync(join(root, "src/palette/loginPage.tsx"), "utf8").replaceAll("\r\n", "\n"); // a Windows checkout may be CRLF
const BODY = /\/\/ @openarc:begin ui\.loginPage\n([\s\S]*?)\n\/\/ @openarc:end/.exec(COMPONENT)![1]!;

const analyzed = async (spec: string) => {
  const ports = fakePorts({ files: { "src/palette/loginPage.spec.tsx": spec, "src/palette/auth.ts": AUTH } }).instance as Ports;
  const p = await engine.parse(ports, req, []);
  const ds: { code: string; detail?: string }[] = [];
  await engine.analyze(ports, req, p, ds as never, { offline: true });
  return { p, ds };
};

// ── 1. the static reader, the vocabulary, scaffolding
const { p, ds } = await analyzed(SPEC);
assert.deepStrictEqual(ds, []);
const spec = p.specs.get("ui.loginPage")!;
assert.deepStrictEqual(spec.ui, {
  param: "props",
  root: {
    tag: "Form", props: { title: "Sign in", onSubmit: { $ref: "props.onLogin" }, onSuccess: { $ref: "props.onSuccess" } },
    children: [
      { tag: "Field", props: { name: "email", type: "email", label: "Email", required: true, autoComplete: "username" }, children: [] },
      { tag: "Field", props: { name: "password", secret: true, label: "Password", required: true, autoComplete: "current-password" }, children: [] },
      { tag: "ErrorText", props: {}, children: [] },
      { tag: "Submit", props: { busyText: "Signing in…" }, children: ["Sign in"] },
    ],
  },
});
assert.deepStrictEqual(spec.deps, ["react"], "react is an allowed import");
const component = p.files.get("src/palette/loginPage.tsx")!;
assert.equal(component, 'import * as arc from "open-arc";\nimport type { LoginPageFn } from "./loginPage.spec.tsx";\n\n// @openarc:begin ui.loginPage\nexport const LoginPage: LoginPageFn = (props) => arc.todo("ui.loginPage");\n// @openarc:end ui.loginPage\n');
assert.equal(p.regions.find((r) => r.id === "ui.loginPage")?.file, "src/palette/loginPage.tsx");
const bad = async (from: string, to: string) => (await analyzed(SPEC.replace(from, to))).ds.map((d) => `${d.code} ${d.detail}`);
assert.deepStrictEqual(await bad("<ErrorText />", "{props.fields.map((f) => <Field name={f} label={f} />)}"), ["OARC-E010 ui:child-expression:props.fields.map((f) => <Field name={f}"]);
assert.deepStrictEqual(await bad("<ErrorText />", "{props.busy ? <ErrorText /> : null}"), ["OARC-E010 ui:child-expression:props.busy ? <ErrorText /> : null"]);
assert.deepStrictEqual(await bad("<Submit ", "<Submit {...props} "), ["OARC-E010 ui:spread"]);
assert.deepStrictEqual(await bad('title="Sign in"', 'title={"Sign " + "in"}'), ['OARC-E010 ui:expression:"Sign " + "in"']);
assert.deepStrictEqual(await bad("<ErrorText />", "<div />"), ["OARC-E010 ui:tag:div"]);
{
  const changed = await analyzed(SPEC.replace('label="Password"', 'label="Passphrase"'));
  assert.notEqual(changed.p.regions.find((r) => r.id === "ui.loginPage")!.specHash, p.regions.find((r) => r.id === "ui.loginPage")!.specHash, "the spec hash covers the structure");
}

// ── 2. the package
{
  const ctx = engine.buildContext(p, p.regions.find((r) => r.id === "ui.loginPage")!, 0, p.config.backends.local!);
  assert.match(ctx, /## Structure \(required; checked in the rendered DOM\)\n<Form title="Sign in" onSubmit=\{props\.onLogin\} onSuccess=\{props\.onSuccess\}>\n {2}<Field name="email" type="email" label="Email" required autoComplete="username" \/>/);
  assert.match(ctx, /## What the structure words mean\nForm: a <form>/);
  assert.match(ctx, /## Allowed new imports\nreact\n/);
  assert.match(ctx, /"script":\[\{"fill":\{"label":"Email","value":"ana@x\.io"\}\}/);
}

// ── 3. no DOM: E092 before any model call
for (const [ui, detail] of [[undefined, "dom:not-configured"], [{ dom: "jsdom" }, "dom:jsdom-missing"]] as const) {
  const config = { version: 1, backends: { local: { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192 } }, ...(ui ? { ui } : {}) };
  const fake = fakePorts({ files: { "src/palette/loginPage.spec.tsx": SPEC, "src/palette/auth.ts": AUTH, "openarc.config.json": JSON.stringify(config), ".openarc/manifest.json": '{"schema":1,"regions":{}}' }, http: [TAGS] });
  const res = await run(fake.instance as Ports, { ...req, ids: ["ui.loginPage"] });
  assert.deepStrictEqual(res.diagnostics.filter((d) => d.code.startsWith("OARC-E")).map((d) => `${d.code} ${d.detail}`), [`OARC-E092 ${detail}`]);
  assert.equal(res.modelCalls, 0);
}
assert.match(String((await import("../src/config.ts")).parseConfig(JSON.stringify({ version: 1, backends: { a: { provider: "ollama", model: "m", maxContextTokens: 1 } }, ui: { dom: "happy-dom" } })).error), /ui\.dom must be "jsdom"/);

// ── 4. the real DOM, through the sandbox
const fixture = join(root, "tests", "fixtures", "ui", "node_modules");
if (!existsSync(join(fixture, "jsdom", "package.json"))) {
  console.log("ui.check: skipped the DOM run (no jsdom in tests/fixtures/ui; run `npm i` there to enable it)");
} else {
  let replies: string[] = [];
  let chats = 0;
  const server = createServer((rq, rs) => {
    let b = "";
    rq.on("data", (x) => (b += x));
    rq.on("end", () => {
      rs.setHeader("content-type", "application/json");
      if (rq.url === "/api/tags") return rs.end(JSON.stringify({ models: [{ name: "stub:1", digest: "d1" }] }));
      rs.end(JSON.stringify({ message: { role: "assistant", content: replies[chats++] ?? "{}" }, done: true }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "openarc-ui-")));
  try {
    cpSync(join(root, "core"), join(dir, "core"), { recursive: true });
    // copies, not links: the bwrap tier sees only the project, so node_modules must live inside it
    cpSync(fixture, join(dir, "node_modules"), { recursive: true });
    cpSync(join(root, "node_modules", "typescript"), join(dir, "node_modules", "typescript"), { recursive: true });
    symlinkSync(process.platform === "win32" ? join(dir, "core") : "../core", join(dir, "node_modules", "open-arc"), "junction");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ui", private: true, type: "module" }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, verbatimModuleSyntax: true, allowImportingTsExtensions: true, skipLibCheck: true, jsx: "react-jsx", lib: ["es2023", "dom"], types: [] }, include: ["src", "tests"] }));
    writeFileSync(join(dir, "openarc.config.json"), JSON.stringify({ version: 1, backends: { stub: { provider: "ollama", model: "stub:1", host: `http://127.0.0.1:${(server.address() as { port: number }).port}`, maxContextTokens: 8192 } }, compilation: { defaultBackend: "stub", maxAttempts: 3 }, ui: { dom: "jsdom" } }));
    mkdirSync(join(dir, "src", "palette"), { recursive: true });
    writeFileSync(join(dir, "src", "palette", "loginPage.spec.tsx"), SPEC);
    writeFileSync(join(dir, "src", "palette", "auth.ts"), pendingCopy(AUTH));
    const reply = (body: string) => JSON.stringify({ body, imports: [{ from: "react", names: ["useState"] }] });
    replies = [
      reply(BODY.replace('password: String(data.get("password") ?? "")', 'password: String(data.get("email") ?? "")')), // miswired
      reply(BODY.replace(' htmlFor="login-password"', "")), // the password input loses its label
      reply(BODY),
    ];
    const c = await new Promise<{ code: number; out: string }>((done) =>
      execFile(process.execPath, [join(root, "src", "main.ts"), "compile", "ui.loginPage"], { cwd: dir, encoding: "utf8", timeout: 600_000 }, (e, stdout, stderr) =>
        done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout}${stderr}` })));
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /3 model call\(s\)/, c.out);
    assert.match(c.out, /ui\.loginPage: ✗ OARC-E090 example "ui: wiring" failed: got \{"problems":\["props\.onLogin called with \[\[\{\\"email\\":\\"a@b\.co\\",\\"password\\":\\"a@b\.co\\"\}\]\]/, c.out);
    assert.match(c.out, /ui\.loginPage: ✗ OARC-E090 example "ui: structure and accessibility" failed: got \{"problems":\["Field password: no input labelled \\"Password\\" \(a11y: accessible name\)"\]\}/, c.out);
    const text = readFileSync(join(dir, "src", "palette", "loginPage.tsx"), "utf8");
    assert.ok(text.includes('import { useState } from "react";') && text.includes('<p role="alert">{error}</p>'), text);
    const m = JSON.parse(readFileSync(join(dir, ".openarc", "manifest.json"), "utf8"));
    assert.deepStrictEqual(m.regions["ui.loginPage"].provenance.verifiedBy, ["tsc", "static", "examples:5/5"]);
    console.log("ui.check: DOM run ok (wiring and a11y failures caught; the palette's LoginPage committed, 5/5 checks)");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log("ui: static reader, E010 subset, scaffold to the component file, package, E092 without a DOM ok");
