// OpenArc for OpenCode: before each file edit asks `openarc guard --hook` whether it would change a compiler-owned
// region (then the edit is refused with the reason), and in a project that uses the sheet (openarc.spec.md) runs
// `openarc sync --watch` for the life of the session. It adds no tools and starts no turns, so a save costs no tokens.
// `openarc setup` installs it as .opencode/plugins/openarc.ts; by hand, copy it to .opencode/plugins/ (or
// ~/.config/opencode/plugins/), and skill/openarc-sheet/ to .opencode/skills/openarc-sheet/.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The OpenArc project folder, relative to the repository root. `openarc setup` rewrites this line.
const PROJECT = ".";

type Args = { filePath?: string; oldString?: string; content?: string; edits?: { oldString?: string }[]; patchText?: string };

export const OpenArc = async ({ directory, worktree }: { directory: string; worktree?: string }) => {
  // PROJECT under the repository root, else under the session's folder: the first that has openarc.config.json
  const root = [worktree, directory].filter((d): d is string => !!d).map((d) => join(d, PROJECT)).find((d) => existsSync(join(d, "openarc.config.json")));
  if (!root) return {};
  // $OPENARC_BIN when set (the package need not be installed), else setup's wrapper, else the project's, else PATH's
  const local = [".openarc/bin/openarc", "node_modules/.bin/openarc"].map((f) => join(root, f)).find((f) => existsSync(f));
  const bin = process.env.OPENARC_BIN || local || "openarc";
  if (existsSync(join(root, "openarc.spec.md"))) {
    const child = spawn(bin, ["sync", "--watch", "--json"], { cwd: root, stdio: "ignore" });
    child.on("error", () => {}); // openarc isn't installed here: nothing to watch
    process.on("exit", () => child.kill());
  }
  return {
    // Claude Code's PreToolUse shape on stdin; exit 2 = blocked, with the reason on stderr. A missing binary passes.
    // ponytail: synchronous, so the session waits the guard's ~0.4 s on each edit.
    "tool.execute.before": async (input: { tool: string }, output: { args: Args }) => {
      if (!["edit", "write", "multiedit", "apply_patch", "patch"].includes(input.tool)) return;
      const a = output.args ?? {};
      const tool_input = { file_path: a.filePath, old_string: a.oldString, content: a.content, edits: a.edits?.map((e) => ({ old_string: e.oldString })), patch: a.patchText };
      const r = spawnSync(bin, ["guard", "--hook"], { cwd: root, input: JSON.stringify({ tool_name: input.tool, tool_input }), encoding: "utf8", timeout: 10_000 });
      if (r.status === 2) throw new Error(r.stderr.trim());
    },
  };
};
