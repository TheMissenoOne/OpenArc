# Setup

`openarc setup` installs OpenArc's agent integration for one project, so Claude Code, Codex or OpenCode can use it next to the project's own skills, hooks and plugins. The project does not need to install `open-arc`.

```
openarc setup [--agents claude,codex,opencode] [--agent-root <dir>] [--dry-run] [--yes] [--remove] [--json]
```

Run it in the project folder: the one holding the code's `package.json`, or any folder you want treated as the OpenArc project.

## What it installs

Paths are relative to the agent root (below). `<project>` is the project folder relative to it, empty when they are the same.

| For | Path | What |
|---|---|---|
| all | `<project>/.openarc/bin/openarc` | the wrapper (below) |
| all | `<project>/.openarc/.gitignore` | gains a `bin/` line |
| all | `<project>/openarc.config.json` | the default config, only if missing. The guard is active only where this file exists |
| all | `AGENTS.md` | one section between `<!-- openarc:begin -->` and `<!-- openarc:end -->`: where the specs live, to read them before the source, the wrapper command, and not to edit code between `// @openarc:begin` and `// @openarc:end`. Created if missing |
| Claude Code | `.claude/skills/openarc-sheet/SKILL.md`, `.claude/skills/openarc-specs/SKILL.md` | the two skills |
| Claude Code | `.claude/settings.local.json` | a `PreToolUse` command hook on `Edit\|Write\|MultiEdit` running `guard --hook`. Exit 2 blocks the edit |
| Codex | `.agents/skills/openarc-sheet/SKILL.md`, `.agents/skills/openarc-specs/SKILL.md` | the two skills |
| Codex | `.codex/hooks.json` | a `PreToolUse` command hook on `apply_patch\|Edit\|Write` running `guard --hook` |
| OpenCode | `.opencode/skills/openarc-sheet/SKILL.md`, `.opencode/skills/openarc-specs/SKILL.md` | the two skills |
| OpenCode | `.opencode/plugins/openarc.ts` | the plugin: the guard in `tool.execute.before`, and the sync watcher in a project with `openarc.spec.md` |

The skills are `openarc-sheet` (the spec sheet and host-agent compiling, see [[Host Agent Mode]]) and `openarc-specs` (the [[Levels]], the [[Decompile]] workflow, and the rules for writing intents with few tokens). Setup copies them from OpenArc's `integrations/` folder and adds one line under the front matter that names the project folder and the wrapper command.

By default it installs for every agent whose binary (`claude`, `codex`, `opencode`) is on the `PATH`. `--agents` picks them; an agent named there is installed even if it is not on the `PATH`.

The Claude Code plugin in `integrations/claude-code` (the pane and the status line, see [[Agent Sync]]) is separate and optional.

## The agent root

Agent tools read their config from the repository root, which can be above the project, for example a project in `repo/desktop` and `.claude/` in `repo/`. The agent root is `--agent-root` if given, else the nearest folder at or above the project that contains `.git`, else the project folder. It must be the project folder or above it.

Every agent file goes under the agent root, and every command in them works from there: with a project in `desktop/`, the skills and `AGENTS.md` say `cd desktop && .openarc/bin/openarc <command>`. The hook command first changes to `git rev-parse --show-toplevel` (when the agent root holds `.git`), then to the project folder, and passes (exit 0) when the wrapper is missing.

## The wrapper

`<project>/.openarc/bin/openarc` is a shell script that runs the OpenArc that ran setup, with the same `node`:

```sh
#!/bin/sh
exec /path/to/node --no-warnings /path/to/open-arc/dist/src/main.js "$@"
```

The paths are this machine's, so `bin/` is in `.openarc/.gitignore`. Skills and hooks call the wrapper, never `npx`. After moving or upgrading OpenArc, run `openarc setup` again to rewrite it.

## Safety

- It first prints every change, `create`, `modify` or `delete`, with a reason. `--dry-run` stops there. Otherwise it asks `Apply? [y/N]` at a terminal; without one it needs `--yes`, and exits 1 without it.
- Before changing or deleting an existing file, it copies it to `<project>/.openarc/backup/setup/<timestamp>/<path>`.
- A second run with nothing new prints `nothing to do`.
- In a settings file it adds its hook entry once and keeps every other key and hook. It recognises its own entry by the text `.openarc/bin/openarc guard --hook`, and replaces it if the project moved. A file it changes is written back with 2-space indentation. A file that is not valid JSON, or not the expected shape, stops setup before it writes anything.
- In `AGENTS.md` it changes only the text between its markers.
- It writes only its own files: `openarc-*` skill folders and `.opencode/plugins/openarc.ts` (a different file already there is backed up, then replaced), the wrapper, its hook entries and its `AGENTS.md` section. It refuses a path outside the agent root, including one that leads out through a symbolic link.

It never touches `.claude/settings.json`, other skills, agents, rules or hooks, or anything in your home directory (`~/.claude`, `~/.codex`, `~/.config/opencode`).

## `--remove`

The same list-and-confirm flow, in reverse: it deletes the skill files and the plugin file it installed, removes its hook entry from each settings file (and deletes the file if nothing else is left in it), removes the `AGENTS.md` section (and the file if it is then empty), and deletes the wrapper. Folders left empty are removed. `openarc.config.json`, `arc/` and `.openarc/` stay. With `--agents`, only those agents' files go; the wrapper and the `AGENTS.md` section go only when all three are removed.

## `--json`

```json
{ "projectRoot": "/abs/repo/desktop", "agentRoot": "/abs/repo", "agents": ["claude", "codex"], "changes": [{ "path": "AGENTS.md", "action": "create", "reason": "..." }], "applied": true }
```

`action` is `create`, `modify`, `delete` or `none`.

## What was checked

Against Claude Code 2.1.323, Codex 0.163.0 and OpenCode 1.19.5, on 2026-11-12:

| Agent | Checked how | Not checked |
|---|---|---|
| Claude Code | `.claude/skills/` and the `settings.local.json` hook shape from its documentation. The hook command itself was run from the agent root with a PreToolUse event on stdin | a running session loading them |
| Codex | the binary's own listing (`codex app-server`: `skills/list` and `hooks/list`) on a tree setup wrote, with the project in a subfolder: both skills found with scope `repo`, and the hook found in `.codex/hooks.json` with source `project`. `AGENTS.md` is read, as `codex debug prompt-input` shows | the hook running in a session |
| OpenCode | `opencode debug skill` and `opencode debug config` on a tree setup wrote: both skills found, and the plugin loaded (a probe plugin in the same folder ran) | the guard refusing an edit in a session |

Things to know:

- **Codex** runs project hooks only in a trusted project, and only after you have reviewed and trusted the hook in Codex. Until then `hooks/list` shows it as `untrusted`. Skills load either way.
- **OpenCode** also reads skills from `.claude/skills/` and `.agents/skills/`. The copies are identical, and OpenCode lists each name once. On first load it writes its own `package.json` and `node_modules/` into `.opencode/`; `--remove` leaves those, since they are not OpenArc's.
- Without `.git` at the agent root, the hook commands assume the agent runs them from the agent root.
