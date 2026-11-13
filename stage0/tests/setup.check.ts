// `openarc setup`: planSetup, pure, then the real CLI in a temp git repo with the project in a subdirectory.
// Run: node --no-warnings tests/setup.check.ts
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTS, guardCommand, mcpCommand, planSetup, type Change, type SetupInput } from "../src/setup.ts";

// ── pure: the change list over an in-memory tree
const base: SetupInput = { project: "", agents: AGENTS, remove: false, git: true, wrapper: "#!/bin/sh\nexec x\n", config: "{}\n", skills: { "openarc-sheet": "---\nname: openarc-sheet\n---\nsheet\n", "openarc-specs": "---\nname: openarc-specs\n---\nspecs\n", "openarc-design": "---\nname: openarc-design\n---\ndesign\n" }, plugin: 'const PROJECT = ".";\nrest\n' };
const apply = (tree: Map<string, string>, cs: Change[]) => {
  for (const c of cs) if (c.action === "delete") tree.delete(c.path); else if (c.action !== "none" && c.action !== "manual") tree.set(c.path, c.content!);
  return tree;
};
const plan = (tree: Map<string, string>, o: Partial<SetupInput> = {}) => planSetup({ ...base, ...o }, (f) => tree.get(f) ?? null);
const todo = (cs: Change[]) => cs.filter((c) => c.action !== "none" && c.action !== "manual");
const roundTrip = (start: Record<string, string>, o: Partial<SetupInput> = {}) => {
  const tree = new Map(Object.entries(start));
  const first = plan(tree, o);
  apply(tree, first);
  assert.deepStrictEqual(todo(plan(tree, o)), [], "a second run has nothing to do");
  const installed = new Map(tree);
  apply(tree, plan(tree, { ...o, remove: true }));
  return { first, installed, removed: tree };
};
{ // a fresh project
  const { first, installed, removed } = roundTrip({});
  assert.ok(first.every((c) => c.action === "create"), "everything is new");
  for (const f of [".openarc/bin/openarc", ".openarc/.gitignore", "openarc.config.json", ".claude/skills/openarc-sheet/SKILL.md", ".claude/skills/openarc-specs/SKILL.md", ".claude/settings.local.json", ".agents/skills/openarc-specs/SKILL.md", ".codex/hooks.json", ".opencode/skills/openarc-sheet/SKILL.md", ".opencode/plugins/openarc.ts", "AGENTS.md", ".mcp.json", "opencode.json", ".codex/config.toml", ...["claude", "agents", "opencode"].map((d) => `.${d}/skills/openarc-design/SKILL.md`)]) assert.ok(installed.has(f), f);
  const cmd = mcpCommand("", true);
  assert.deepStrictEqual(JSON.parse(installed.get(".mcp.json")!), { mcpServers: { openarc: { type: "stdio", command: "sh", args: ["-c", cmd] } } });
  assert.deepStrictEqual(JSON.parse(installed.get("opencode.json")!), { mcp: { openarc: { type: "local", command: ["sh", "-c", cmd], enabled: true } } });
  assert.strictEqual(installed.get(".codex/config.toml"), `# openarc:begin\n[mcp_servers.openarc]\ncommand = "sh"\nargs = ["-c", ${JSON.stringify(cmd)}]\ntool_timeout_sec = 120\n# openarc:end\n`);
  assert.match(cmd, /&& exec \.openarc\/bin\/openarc mcp$/);
  assert.match(installed.get(".claude/skills/openarc-specs/SKILL.md")!, /^---\nname: openarc-specs\n---\n\n> Installed by `openarc setup`.*repository's root/);
  assert.strictEqual(installed.get(".openarc/.gitignore"), "bin/\n");
  const hook = JSON.parse(installed.get(".claude/settings.local.json")!).hooks.PreToolUse;
  assert.deepStrictEqual(hook, [{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: guardCommand("", true), timeout: 15 }] }]);
  assert.strictEqual(JSON.parse(installed.get(".codex/hooks.json")!).hooks.PreToolUse[0].matcher, "apply_patch|Edit|Write");
  assert.deepStrictEqual([...removed.keys()].sort(), [".openarc/.gitignore", "openarc.config.json"], "remove leaves only the config and .openarc state");
}
{ // existing settings and AGENTS.md: kept outside our parts, and restored exactly by --remove
  const settings = JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint.sh" }] }], Stop: [{ hooks: [{ type: "command", command: "bell" }] }] } }, null, 2) + "\n";
  const agents = "# Rules\n\nBe brief.\n";
  const { first, installed, removed } = roundTrip({ ".claude/settings.local.json": settings, "AGENTS.md": agents, ".claude/skills/mine/SKILL.md": "mine" });
  assert.strictEqual(first.find((c) => c.path === ".claude/settings.local.json")!.action, "modify");
  const s = JSON.parse(installed.get(".claude/settings.local.json")!);
  assert.deepStrictEqual(s.permissions, { allow: ["Bash(ls)"] });
  assert.strictEqual(s.hooks.PreToolUse.length, 2);
  assert.strictEqual(s.hooks.PreToolUse[0].hooks[0].command, "lint.sh");
  assert.ok(s.hooks.Stop);
  assert.ok(installed.get("AGENTS.md")!.startsWith(agents + "\n<!-- openarc:begin -->"), "appended after the existing text");
  assert.strictEqual(removed.get(".claude/settings.local.json"), settings);
  assert.strictEqual(removed.get("AGENTS.md"), agents);
  assert.strictEqual(removed.get(".claude/skills/mine/SKILL.md"), "mine");
}
{ // MCP configs with other servers: ours added next to them, and --remove restores the files exactly
  const mcp = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2) + "\n";
  const oc = JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { other: { type: "local", command: ["x"] } } }, null, 2) + "\n";
  const toml = `model = "x"\n\n# openarc:begin\nold\n# openarc:end\n`;
  const { first, installed, removed } = roundTrip({ ".mcp.json": mcp, "opencode.json": oc, ".codex/config.toml": toml });
  assert.ok(first.every((c) => c.action !== "manual"));
  assert.deepStrictEqual(Object.keys(JSON.parse(installed.get(".mcp.json")!).mcpServers), ["other", "openarc"]);
  assert.deepStrictEqual(Object.keys(JSON.parse(installed.get("opencode.json")!).mcp), ["other", "openarc"]);
  assert.match(installed.get(".codex/config.toml")!, /^model = "x"\n\n# openarc:begin\n\[mcp_servers\.openarc\]\n/);
  assert.strictEqual(removed.get(".mcp.json"), mcp);
  assert.strictEqual(removed.get("opencode.json"), oc);
  assert.strictEqual(removed.get(".codex/config.toml"), `model = "x"\n`, "our section goes, theirs stays");
}
{ // what setup can't merge safely: listed as "manual" with the lines to add, never written
  const start = { ".codex/config.toml": 'model = "x"\n', "opencode.jsonc": "{ // mine\n}\n", ".mcp.json": '{ "mcpServers": { "openarc": { "command": "theirs" } } }\n' };
  const tree = new Map(Object.entries(start));
  const cs = plan(tree);
  const manual = cs.filter((c) => c.action === "manual");
  assert.deepStrictEqual(manual.map((c) => c.path).sort(), [".codex/config.toml", ".mcp.json", "opencode.jsonc"]);
  assert.match(manual.find((c) => c.path === ".codex/config.toml")!.content!, /^\[mcp_servers\.openarc\]\ncommand = "sh"\nargs = \["-c", ".*openarc mcp"\]\ntool_timeout_sec = 120\n$/);
  assert.ok(!cs.some((c) => c.path === "opencode.json"), "no opencode.json next to an opencode.jsonc");
  apply(tree, cs);
  for (const [f, t] of Object.entries(start)) assert.strictEqual(tree.get(f), t, f);
  assert.ok(!plan(tree, { remove: true }).some((c) => c.action === "manual" || [".codex/config.toml", ".mcp.json", "opencode.jsonc"].includes(c.path)), "--remove leaves them alone");
}
{ // a section already there is replaced in place; a moved project rewrites our hook instead of adding a second
  const tree = new Map([["AGENTS.md", "top\n<!-- openarc:begin -->\nold\n<!-- openarc:end -->\nbottom\n"]]);
  apply(tree, plan(tree));
  assert.match(tree.get("AGENTS.md")!, /^top\n<!-- openarc:begin -->\n## OpenArc[\s\S]*<!-- openarc:end -->\nbottom\n$/);
  apply(tree, plan(tree, { project: "app" }));
  assert.strictEqual(JSON.parse(tree.get(".claude/settings.local.json")!).hooks.PreToolUse.length, 1);
  assert.match(tree.get(".claude/settings.local.json")!, /cd app 2>\/dev\/null/);
}
{ // the project below the agent root: its files and every command carry the relative folder
  const { installed, removed } = roundTrip({}, { project: "desktop" });
  assert.ok(installed.has("desktop/.openarc/bin/openarc") && installed.has("desktop/openarc.config.json") && !installed.has(".openarc/bin/openarc"));
  assert.match(installed.get("AGENTS.md")!, /`cd desktop && \.openarc\/bin\/openarc status`/);
  assert.match(installed.get("AGENTS.md")!, /`desktop\/arc\/features\/`[^\n]*`cd desktop && \.openarc\/bin\/openarc pdl show <id>`/);
  assert.match(installed.get(".agents/skills/openarc-sheet/SKILL.md")!, /`cd desktop && \.openarc\/bin\/openarc <command>`/);
  assert.match(installed.get(".opencode/plugins/openarc.ts")!, /^const PROJECT = "desktop";/);
  assert.match(installed.get(".mcp.json")!, /cd desktop && exec \.openarc\/bin\/openarc mcp/);
  assert.deepStrictEqual([...removed.keys()].sort(), ["desktop/.openarc/.gitignore", "desktop/openarc.config.json"]);
}
{ // refusals: a broken settings file, a half section, a path out of the root
  assert.throws(() => plan(new Map([[".claude/settings.local.json", "{ nope"]])), /settings\.local\.json/);
  assert.throws(() => plan(new Map([["AGENTS.md", "<!-- openarc:begin -->\n"]])), /without/);
  assert.throws(() => plan(new Map(), { project: "../x" }), /outside the agent root/);
}

if (process.platform === "win32") {
  console.log("setup.check ok (pure checks only on Windows)");
  process.exit(0);
}

// ── the real CLI: a git repo, the project in desktop/, an existing .claude/settings.json and a foreign skill
const MAIN = resolve("src/main.ts");
const repo = mkdtempSync(join(resolve(".."), ".setup-check-"));
const project = join(repo, "desktop");
const oa = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", MAIN, "setup", ...args], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** Every file under the repo except .git, with its text. */
const snapshot = (skip: (f: string) => boolean = () => false): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d)) {
      const r = rel ? `${rel}/${n}` : n;
      if (r === ".git" || skip(r)) continue;
      if (statSync(join(d, n)).isDirectory()) walk(join(d, n), r);
      else out[r] = readFileSync(join(d, n), "utf8");
    }
  };
  walk(repo, "");
  return out;
};
try {
  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(repo, ".claude/skills/theirs"), { recursive: true });
  writeFileSync(join(project, "package.json"), '{ "type": "module" }\n');
  writeFileSync(join(project, "src/a.js"), "export const a = 1;\n");
  writeFileSync(join(repo, ".claude/settings.json"), '{ "model": "x" }\n');
  writeFileSync(join(repo, ".claude/skills/theirs/SKILL.md"), "---\nname: theirs\n---\n");
  const start = snapshot();
  const all = ["--agents", "claude,codex,opencode"];

  let r = oa([...all, "--dry-run"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /create \.claude\/settings\.local\.json/);
  assert.deepStrictEqual(snapshot(), start, "--dry-run writes nothing");
  r = oa(all);
  assert.strictEqual(r.status, 1, "no terminal and no --yes");
  assert.match(r.stderr, /--yes/);
  assert.deepStrictEqual(snapshot(), start);

  r = oa([...all, "--yes", "--json"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout) as { projectRoot: string; agentRoot: string; agents: string[]; changes: Change[]; applied: boolean };
  assert.strictEqual(rep.applied, true);
  assert.strictEqual(rep.agentRoot, repo);
  assert.strictEqual(rep.projectRoot, project);
  assert.deepStrictEqual(rep.agents, ["claude", "codex", "opencode"]);
  for (const f of ["desktop/.openarc/bin/openarc", "desktop/openarc.config.json", ".claude/skills/openarc-sheet/SKILL.md", ".claude/skills/openarc-specs/SKILL.md", ".claude/settings.local.json", ".agents/skills/openarc-sheet/SKILL.md", ".agents/skills/openarc-specs/SKILL.md", ".codex/hooks.json", ".opencode/skills/openarc-specs/SKILL.md", ".opencode/plugins/openarc.ts", "AGENTS.md", ".mcp.json", "opencode.json", ".codex/config.toml", ...["claude", "agents", "opencode"].map((d) => `.${d}/skills/openarc-design/SKILL.md`)]) assert.ok(existsSync(join(repo, f)), f);
  for (const d of ["claude-code/skills", "codex/skills", "opencode/skill"]) assert.strictEqual(readFileSync(resolve(`../integrations/${d}/openarc-design/SKILL.md`), "utf8"), readFileSync(resolve("../integrations/claude-code/skills/openarc-design/SKILL.md"), "utf8"), `${d}: one skill text for every agent`);
  assert.strictEqual(readFileSync(join(repo, ".agents/skills/openarc-design/SKILL.md"), "utf8").replace(/\n> Installed by[^\n]*\n/, ""), readFileSync(resolve("../integrations/claude-code/skills/openarc-design/SKILL.md"), "utf8"));
  assert.strictEqual(readFileSync(join(repo, ".claude/skills/openarc-specs/SKILL.md"), "utf8").replace(/\n> Installed by[^\n]*\n/, ""), readFileSync(resolve("../integrations/claude-code/skills/openarc-specs/SKILL.md"), "utf8"), "the shipped skill plus the preamble");
  const now = snapshot();
  assert.strictEqual(now[".claude/settings.json"], start[".claude/settings.json"]);
  assert.strictEqual(now[".claude/skills/theirs/SKILL.md"], start[".claude/skills/theirs/SKILL.md"]);
  assert.match(now["desktop/.openarc/.gitignore"]!, /^bin\/$/m);

  const wrapper = join(project, ".openarc/bin/openarc");
  accessSync(wrapper, constants.X_OK);
  const w = spawnSync(wrapper, [], { cwd: project, encoding: "utf8" });
  assert.strictEqual(w.status, 2, "no command: usage");
  assert.match(w.stderr, /usage: openarc .*\n[\s\S]*openarc setup/);

  // the installed hook, from the agent root: an ordinary edit passes
  const cmd = JSON.parse(now[".claude/settings.local.json"]!).hooks.PreToolUse[0].hooks[0].command as string;
  const h = spawnSync("sh", ["-c", cmd], { cwd: repo, encoding: "utf8", input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(project, "src/a.js"), old_string: "1", new_string: "2" } }) });
  assert.strictEqual(h.status, 0, h.stderr);

  // the installed MCP server command, from a subfolder: the handshake answers through the wrapper
  const server = JSON.parse(now[".mcp.json"]!).mcpServers.openarc as { command: string; args: string[] };
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "check", version: "1" } } });
  const m = spawnSync(server.command, server.args, { cwd: join(project, "src"), encoding: "utf8", input: init + "\n" });
  assert.strictEqual(m.status, 0, m.stderr);
  assert.strictEqual(JSON.parse(m.stdout).result.serverInfo.name, "openarc");

  r = oa([...all, "--yes"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to do/);
  assert.deepStrictEqual(snapshot(), now, "a second run changes nothing");

  r = oa(["--remove", "--yes"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const skip = (f: string) => f === "desktop/openarc.config.json" || f === "desktop/.openarc";
  assert.deepStrictEqual(snapshot(skip), start, "--remove returns the tree to where it started");
  assert.ok(existsSync(join(project, "openarc.config.json")), "the config stays");
} finally {
  rmSync(repo, { recursive: true, force: true });
}
console.log("setup.check ok");
