// Runs suite.cjs inside a real VS Code (downloaded once into .vscode-test/) on a copy of fixture/.
// Needs a display: on a headless Linux box, `xvfb-run -a npm run test:integration`.
// VSCODE_TEST_VERSION picks the VS Code version (default: stable; the oldest supported is 1.85.0).
import { runTests } from "@vscode/test-electron";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error("no display: run `xvfb-run -a npm run test:integration`");
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "openarc-it-"));
const ws = join(tmp, "ws");
cpSync(join(here, "fixture"), ws, { recursive: true });
// written here, not kept in fixture/: the extension would otherwise treat the fixture as a project of this repo
writeFileSync(join(ws, "openarc.config.json"), "{}\n");
try {
  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? "stable",
    extensionDevelopmentPath: join(here, "..", ".."),
    extensionTestsPath: join(here, "suite.cjs"),
    launchArgs: [ws, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--user-data-dir", join(tmp, "user")],
    extensionTestsEnv: { OPENARC_TEST_WS: ws, OPENARC_FAKE_LOG: join(tmp, "cli-calls.log") },
  });
} catch (e) {
  console.error(`integration tests failed: ${e.message ?? e}`);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
