// OpenArc for OpenCode: runs `openarc sync --watch` for the life of the session. It adds no tools and starts no turns,
// so a save costs no tokens. Copy to .opencode/plugin/ (or ~/.config/opencode/plugins/), and skill/openarc-sheet/ to
// .opencode/skill/openarc-sheet/.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const OpenArc = async ({ directory }: { directory: string }) => {
  if (existsSync(join(directory, "openarc.config.json"))) {
    const child = spawn(existsSync(join(directory, "node_modules/.bin/openarc")) ? "node_modules/.bin/openarc" : "openarc", ["sync", "--watch", "--json"], { cwd: directory, stdio: "ignore" });
    child.on("error", () => {}); // openarc isn't installed here: nothing to watch
    process.on("exit", () => child.kill());
  }
  return {};
};
