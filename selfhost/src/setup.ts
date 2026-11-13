// `openarc setup`: installs OpenArc's agent integration for one project: the skills, the pre-edit guard hook, a section
// in AGENTS.md, and a wrapper script that runs this OpenArc. Hand-written. planSetup computes every change from the files'
// current text and the options, and is pure; setupCommand reads, prints, asks, backs up and writes.
// It writes only under the agent root (the repository root, where agent tools read their config), never in a home
// directory, and never deletes or overwrites a file that isn't OpenArc's own: `openarc-*` skill folders, the OpenCode
// plugin file, the wrapper, and the hook entries and AGENTS.md section it recognises by their text.
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export type Agent = "claude" | "codex" | "opencode";
export const AGENTS: readonly Agent[] = ["claude", "codex", "opencode"];
export const SKILLS = ["openarc-sheet", "openarc-specs"] as const;
export type Change = { path: string; action: "create" | "modify" | "delete" | "none"; reason: string; content?: string };
export type SetupInput = {
  project: string; // the project folder relative to the agent root, "/"-separated; "" when they are the same
  agents: readonly Agent[];
  remove: boolean;
  git: boolean; // the agent root holds .git: hook commands start from `git rev-parse --show-toplevel`, whatever the session's folder
  wrapper: string; // the wrapper script's text
  config: string; // the default openarc.config.json
  skills: Record<string, string>; // name -> SKILL.md as shipped in integrations/
  plugin: string; // integrations/opencode/openarc.ts
};

const BIN = ".openarc/bin/openarc";
const GUARD = `${BIN} guard --hook`; // how a later run recognises its own hook entry
const BEGIN = "<!-- openarc:begin -->";
const END = "<!-- openarc:end -->";
const PROJECT_LINE = 'const PROJECT = ".";';
const SKILL_DIRS: Record<Agent, string> = { claude: ".claude/skills", codex: ".agents/skills", opencode: ".opencode/skills" };
const PLUGIN = ".opencode/plugins/openarc.ts";
const HOOKS: Partial<Record<Agent, { file: string; matcher: string }>> = {
  claude: { file: ".claude/settings.local.json", matcher: "Edit|Write|MultiEdit" },
  codex: { file: ".codex/hooks.json", matcher: "apply_patch|Edit|Write" },
};
const NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

const sh = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const p = (project: string, rel: string) => (project ? `${project}/${rel}` : rel);
/** The command, run from the agent root, that runs OpenArc in the project. */
const run = (project: string, args: string) => (project ? `cd ${sh(project)} && ${BIN} ${args}` : `${BIN} ${args}`);

/** The guard hook's shell command. A missing wrapper or project passes: a hook must never block what it can't check.
 *  ponytail: with --agent-root on a folder that isn't a git root, it assumes the agent runs hooks from that folder. */
export function guardCommand(project: string, git: boolean): string {
  const cd = [git ? 'cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"' : "", project ? `cd ${sh(project)} 2>/dev/null` : ""].filter(Boolean);
  return `${[...cd, `[ -x ${BIN} ]`].join(" && ")} || exit 0; exec ${GUARD}`;
}

/** A skill as installed: the shipped text with a preamble saying where the project is and how to run OpenArc there. */
function skillText(text: string, project: string): string {
  const where = project ? `The OpenArc project is \`${project}/\` in this repository: run OpenArc from the repository root as \`${run(project, "<command>")}\`` : "The OpenArc project is this repository's root: run OpenArc there as `.openarc/bin/openarc <command>`";
  const note = `> Installed by \`openarc setup\`. ${where}. That wrapper is how to call \`openarc\` everywhere below.\n`;
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  return m ? `${m[0]}\n${note}${text.slice(m[0].length)}` : `${note}\n${text}`;
}

function agentsSection(project: string): string {
  const arc = p(project, "arc/");
  return [BEGIN, "## OpenArc", "",
    `This project's behaviour is described in OpenArc specs under \`${arc}\`: \`concept.arc\` (goals), \`architecture.arc\` (parts and modules) and \`spec/<module>.arc\` (one per source module). Read a module's \`.arc\` file before its source: it is much smaller.`, "",
    `Run OpenArc as \`${run(project, "<command>")}\`, for example \`${run(project, "status")}\`. Never \`npx openarc\`.`, "",
    "Do not edit code between `// @openarc:begin` and `// @openarc:end` markers: change its spec instead. The `openarc-specs` and `openarc-sheet` skills say more.",
    END].join("\n") + "\n";
}

/** AGENTS.md with our section added, replaced in place, or removed (null: the file would be empty). Text outside the
 *  markers stays byte for byte, except the one blank line put before an appended section, which removal takes back. */
export function withSection(cur: string | null, section: string | null): string | null {
  const t = cur ?? "";
  const b = t.indexOf(BEGIN), e = b < 0 ? -1 : t.indexOf(END, b);
  if (b >= 0 && e < 0) throw new Error(`AGENTS.md: ${BEGIN} without ${END}; fix it by hand first`);
  if (b < 0 && section === null) return cur;
  if (b < 0) return t + (t && !t.endsWith("\n") ? "\n" : "") + (t ? "\n" : "") + section;
  let end = e + END.length;
  if (t[end] === "\n") end++;
  if (section !== null) return t.slice(0, b) + section + t.slice(end);
  const start = b >= 2 && t.slice(b - 2, b) === "\n\n" ? b - 1 : b;
  const out = t.slice(0, start) + t.slice(end);
  return out === "" ? null : out;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const ours = (h: unknown) => isObj(h) && typeof h.command === "string" && h.command.includes(GUARD);

/** A settings or hooks.json file with our PreToolUse entry added once, or removed (null: the file would hold nothing).
 *  Every other key and hook stays. ponytail: a file it changes is re-serialised with 2-space indentation. */
export function withHook(file: string, cur: string | null, matcher: string, command: string, remove: boolean): string | null {
  let o: unknown;
  try { o = cur === null ? {} : JSON.parse(cur); } catch { o = undefined; }
  if (!isObj(o) || (o.hooks !== undefined && !isObj(o.hooks)) || (isObj(o.hooks) && o.hooks.PreToolUse !== undefined && !Array.isArray(o.hooks.PreToolUse))) {
    throw new Error(`${file}: not the settings shape expected (an object, hooks.PreToolUse an array); fix it by hand first`);
  }
  const group = { matcher, hooks: [{ type: "command", command, timeout: 15 }] };
  const pre: unknown[] = o.hooks?.PreToolUse ?? [];
  const has = pre.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(ours));
  if (remove ? !has : pre.some((g) => JSON.stringify(g) === JSON.stringify(group))) return cur;
  if (has) {
    const left = pre
      .filter((g) => !(isObj(g) && Array.isArray(g.hooks) && g.hooks.length && g.hooks.every(ours)))
      .map((g) => (isObj(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h: unknown) => !ours(h)) } : g));
    if (left.length) o.hooks.PreToolUse = left;
    else delete o.hooks.PreToolUse;
    if (!Object.keys(o.hooks).length) delete o.hooks;
  }
  if (!remove) ((o.hooks ??= {}).PreToolUse ??= []).push(group);
  return Object.keys(o).length ? JSON.stringify(o, null, 2) + "\n" : null;
}

/** Every change setup (or `--remove`) would make, paths relative to the agent root. `read` gives a file's current text,
 *  null when missing. Pure. Throws on a file it must not touch (a broken AGENTS.md section, unreadable settings). */
export function planSetup(i: SetupInput, read: (path: string) => string | null): Change[] {
  const out: Change[] = [];
  const put = (path: string, next: string | null, reason: string) => {
    const cur = read(path);
    if (cur === next) out.push({ path, action: "none", reason: "up to date" });
    else if (next === null) out.push({ path, action: "delete", reason });
    else out.push({ path, action: cur === null ? "create" : "modify", reason: cur === null ? reason : `${reason} (replaces what is there; backed up)`, content: next });
  };
  const edit = (path: string, next: string | null, reason: string) => { // a file shared with others: keep what isn't ours
    const cur = read(path);
    if (cur === next) out.push({ path, action: "none", reason: "up to date" });
    else out.push({ path, action: next === null ? "delete" : cur === null ? "create" : "modify", reason, ...(next === null ? {} : { content: next }) });
  };
  const all = AGENTS.every((a) => i.agents.includes(a));
  if (!i.remove) {
    put(p(i.project, BIN), i.wrapper, "the wrapper that runs this OpenArc (machine-specific)");
    const gi = p(i.project, ".openarc/.gitignore"), had = read(gi);
    if (!(had ?? "").split("\n").includes("bin/")) edit(gi, (had ?? "") + (had && !had.endsWith("\n") ? "\n" : "") + "bin/\n", "do not commit the wrapper");
    if (read(p(i.project, "openarc.config.json")) === null) edit(p(i.project, "openarc.config.json"), i.config, "the default config: the guard hook is active only where this file exists");
  } else if (all && read(p(i.project, BIN)) !== null) put(p(i.project, BIN), null, "the wrapper");
  for (const a of i.agents) {
    for (const s of SKILLS) {
      const path = `${SKILL_DIRS[a]}/${s}/SKILL.md`;
      if (i.remove) { if (read(path) !== null) put(path, null, `${NAMES[a]} skill`); }
      else put(path, skillText(i.skills[s]!, i.project), `${NAMES[a]} skill`);
    }
    const h = HOOKS[a];
    if (h) edit(h.file, withHook(h.file, read(h.file), h.matcher, guardCommand(i.project, i.git), i.remove), i.remove ? `remove the ${NAMES[a]} guard hook` : `add the guard as a ${NAMES[a]} PreToolUse hook (blocks hand edits of compiler-owned code)`);
    if (a === "opencode") {
      if (!i.plugin.includes(PROJECT_LINE)) throw new Error(`integrations/opencode/openarc.ts: no line \`${PROJECT_LINE}\` to point at the project`);
      if (i.remove) { if (read(PLUGIN) !== null) put(PLUGIN, null, "OpenCode plugin"); }
      else put(PLUGIN, i.plugin.replace(PROJECT_LINE, `const PROJECT = ${JSON.stringify(i.project || ".")};`), "OpenCode plugin: the guard before each edit");
    }
  }
  if (!i.remove || all) edit("AGENTS.md", withSection(read("AGENTS.md"), i.remove ? null : agentsSection(i.project)), i.remove ? "remove the OpenArc section" : "an OpenArc section between openarc markers; the rest stays as it is");
  for (const c of out) if (isAbsolute(c.path) || c.path.split("/").includes("..")) throw new Error(`refusing ${c.path}: outside the agent root`);
  return out;
}

// ── the command

const onPath = (bin: string) => (process.env.PATH ?? "").split(delimiter).some((d) => {
  try { accessSync(join(d, bin), constants.X_OK); return d !== "" && statSync(join(d, bin)).isFile(); } catch { return false; }
});

/** The wrapper: execs the node and the entry running now, so a project needs no `open-arc` install. */
function wrapperText(): string {
  const here = fileURLToPath(import.meta.url);
  const entry = join(dirname(here), `main${extname(here)}`); // src/main.ts from source, dist/src/main.js from the package
  if (!existsSync(entry)) throw new Error(`cannot find OpenArc's entry next to ${here}`);
  return `#!/bin/sh\n# Written by \`openarc setup\`: runs the OpenArc that installed it. Machine-specific, so .openarc/.gitignore leaves it out.\nexec ${sh(process.execPath)} --no-warnings ${sh(entry)} "$@"\n`;
}

/** The files setup installs, from integrations/ next to this OpenArc (the repo's, or the one the npm build ships). */
function shipped(): { skills: Record<string, string>; plugin: string } {
  const dir = fileURLToPath(new URL("../../integrations/", import.meta.url));
  const f = (rel: string) => {
    try { return readFileSync(join(dir, rel), "utf8"); } catch { throw new Error(`missing ${join(dir, rel)}: this OpenArc was installed without integrations/`); }
  };
  return { skills: Object.fromEntries(SKILLS.map((s) => [s, f(`claude-code/skills/${s}/SKILL.md`)])), plugin: f("opencode/openarc.ts") };
}

/** `openarc setup ...`, run in the project folder. Returns the exit code. */
export async function setupCommand(cwd: string, argv: string[], config: string, usage: string): Promise<number> {
  const bad = (why: string) => (console.error(`openarc: ${why}\n\n${usage}`), 2);
  let agents: Agent[] | null = null, agentRoot: string | null = null, dry = false, yes = false, remove = false, json = false;
  for (let k = 0; k < argv.length; k++) {
    const f = argv[k]!, v = argv[k + 1];
    if (f === "--dry-run") dry = true;
    else if (f === "--yes") yes = true;
    else if (f === "--remove") remove = true;
    else if (f === "--json") json = true;
    else if (f === "--agents" && v && !agents) {
      const list = v.split(",").filter(Boolean);
      if (!list.length || list.some((a) => !(AGENTS as readonly string[]).includes(a))) return bad(`unknown agent in ${v}: use ${AGENTS.join(",")}`);
      (agents = [...new Set(list)] as Agent[]), k++;
    } else if (f === "--agent-root" && v && agentRoot === null) (agentRoot = resolve(cwd, v)), k++;
    else return bad("bad-flag");
  }
  const project = resolve(cwd);
  let root = agentRoot;
  if (root === null) for (let d = project; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) { root = d; break; }
    if (dirname(d) === d) { root = project; break; }
  }
  const rel = relative(root, project).split(sep).join("/");
  if (rel.startsWith("..") || isAbsolute(rel)) return console.error(`openarc: the agent root ${root} must be the project folder or one above it`), 1;
  const chosen = agents ?? (remove ? [...AGENTS] : AGENTS.filter(onPath));
  const real = (() => { try { return realpathSync(root); } catch { return root; } })();
  let changes: Change[];
  try {
    const read = (path: string): string | null => {
      try { return readFileSync(join(root, path), "utf8"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
        throw new Error(`${path}: ${(e as Error).message}`);
      }
    };
    changes = planSetup({ project: rel, agents: chosen, remove, git: existsSync(join(root, ".git")), wrapper: wrapperText(), config, ...shipped() }, read);
    // A symlinked folder (a .claude linked to a home config, say) would take a write outside the agent root: refuse it.
    for (const c of changes) {
      if (c.action === "none") continue;
      let d = join(root, c.path);
      while (!existsSync(d)) d = dirname(d);
      const r = relative(real, realpathSync(d));
      if (r.startsWith("..") || isAbsolute(r)) throw new Error(`refusing ${c.path}: ${d} leads outside the agent root`);
    }
  } catch (e) {
    return console.error(`openarc: ${(e as Error).message}`), 1;
  }
  const todo = changes.filter((c) => c.action !== "none");
  const report = (applied: boolean) => JSON.stringify({ projectRoot: project, agentRoot: root, agents: chosen, changes: changes.map(({ path, action, reason }) => ({ path, action, reason })), applied });
  const log = (l: string) => (json ? console.error(l) : console.log(l));
  if (!json) {
    console.log(`project ${project}\nagent root ${root}\nagents ${chosen.length ? chosen.map((a) => NAMES[a]).join(", ") : `none on PATH (choose with --agents ${AGENTS.join(",")})`}`);
    for (const c of todo) console.log(`  ${c.action.padEnd(6)} ${c.path}: ${c.reason}`);
    if (!todo.length) console.log("nothing to do");
    if (!remove && chosen.includes("codex") && todo.length) console.log("note: Codex runs .codex/hooks.json only in a trusted project, and only once you have reviewed and trusted the hook in Codex");
  }
  if (!todo.length || dry) return json && console.log(report(false)), 0;
  if (!yes) {
    if (!process.stdin.isTTY) return console.error("openarc: setup changes files: pass --yes to apply without a terminal, or --dry-run to only list"), 1;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question("Apply? [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return log("nothing changed"), json && console.log(report(false)), 1;
  }
  const backup = join(project, ".openarc/backup/setup", new Date().toISOString().replace(/[:.]/g, "-"));
  for (const c of todo) {
    const abs = join(root, c.path);
    if (c.action !== "create") { // back up whatever is there before changing it
      mkdirSync(dirname(join(backup, c.path)), { recursive: true });
      cpSync(abs, join(backup, c.path));
    }
    if (c.action === "delete") {
      rmSync(abs);
      for (let d = dirname(abs); d !== root && d.startsWith(root + sep) && !readdirSync(d).length; d = dirname(d)) rmdirSync(d); // folders left empty. ponytail: also one that was empty before setup
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c.content!);
      if (c.path.endsWith(BIN)) chmodSync(abs, 0o755);
    }
  }
  if (todo.some((c) => c.action !== "create")) log(`backups in ${relative(cwd, backup) || "."}`);
  log(`applied ${todo.length} change${todo.length === 1 ? "" : "s"}`);
  if (json) console.log(report(true));
  return 0;
}
