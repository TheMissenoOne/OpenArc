# Host Agent Mode

Inside Claude Code, Codex or OpenCode, the agent you're already talking to can write a region's body itself. OpenArc gives it the exact prompt a model would get, then checks and commits what it writes. OpenArc calls no model and needs no backend running, so you don't pay for a second context the way you do with a `claude-cli` backend.

```bash
openarc prompt text.slug > prompt.txt     # what to write
# ... the agent writes the body ...
openarc accept text.slug < body.ts        # check it and commit it, or print the problems
```

A third command, `openarc guard`, stops an agent from editing compiler-owned code by hand.

The commands print plain lines, or one JSON object with `--json`, so any skill, plugin or subagent can call them.

## `openarc prompt <id> [--json]`

Prints the prompt `compile` would send for the region's first attempt at its initial context level: the same context (`buildContext`) and the same template. The format is always "code", whatever the backend's `outputFormat`, because `accept` reads code. The first line tells the agent what to reply with:

```
Pipe your reply to `openarc accept text.slug`: the function BODY only: statements, no signature, no markers, no code fences; import lines at the top if needed.

Implement exactly one OpenArc region in TypeScript.
...
```

For a sketch region, the reply is the sketch's statements with every hole filled.

`--json` prints `{ "id", "file", "signature", "outputFormat": "code", "system", "prompt" }` without the instruction line.

The command only reads. It exits 0. It exits 1 for an unknown id (`no region <id>`), a developer-owned, conflicted or held region (`**Hold**` in `openarc.spec.md`), and a block or a function with blocks inside. Use `openarc compile` for those.

## `openarc accept <id> [--file <path>] [--json]`

Reads a body from stdin, or from `--file`, and runs it through the pipeline a model's reply goes through, for this one region:

1. Body normalisation. A surrounding code fence is dropped, and leading `import` lines become imports.
2. Static rules.
3. The write-scope guards.
4. The splice.
5. The type check.
6. The region's examples and tests in the sandbox. Callers that use the region are checked again too.
7. Staging, the manifest, and the transactional commit, all under the usual lock.

`accept` makes one attempt, with no repair loop, no fallback backend and no model request.

| Result | Exit | Plain | `--json` |
|---|---|---|---|
| committed | 0 | `accepted <id>` | `{"ok":true,"id":"<id>","file":"src/x.ts"}` |
| rejected | 1 | one problem per line, as compile reports it | `{"ok":false,"id":"<id>","problems":[...]}` |
| refused | 1 | the reason, on stderr | the reason, on stderr |
| bad flag | 2 | usage | usage |

Problem lines look like this:

```
OARC-E090 example "#1" failed: got 3; expected 2
OARC-E070 TS2322 line 5: Type 'string' is not assignable to type 'number'.
    > return 'one';
```

A rejection writes nothing. The source, the manifest and the cache stay as they were. The failure isn't recorded in `.openarc/attempts/` or in `.openarc/failed.json`, so a later `openarc compile` still tries the region. Fix the body and run `accept` again.

A committed body is compiler-owned, with the same fingerprint `compile` would record, so a following `openarc compile` has nothing to do for it. Its provenance names backend `host` and model `host-agent`, with no tokens. Nothing goes in `.openarc/usage.jsonl`, so it doesn't count toward `sync.maxHostedTokensPerDay`.

It's refused for the same regions as `prompt`, and for one that is already verified and up to date. With an Ollama default backend, Ollama must answer `/api/tags`, since the fingerprint includes the model digest. No model is loaded.

## `openarc guard`

`openarc guard [files...] [--json]` is a check to run after edits. It lists every compiler-owned region whose body no longer matches the manifest (`OARC-W060`) or whose markers are gone (`OARC-E062`), optionally only in the given files. It exits 1 if it finds any, and 0 otherwise.

```
src/text.ts: text.slug is compiler-owned and was edited by hand; edit its spec and recompile, or `openarc freeze text.slug` to own it
```

`--json` prints `{"ok":false,"edited":[{"id":"text.slug","file":"src/text.ts","what":"edited by hand"}]}`.

`openarc guard --hook` is the check that runs before an edit. It reads one PreToolUse event on stdin, in Claude Code's shape:

```json
{ "tool_name": "Edit", "tool_input": { "file_path": "/abs/src/text.ts", "old_string": "...", "new_string": "..." } }
```

It blocks the edit in these cases:

- **Edit or MultiEdit:** an occurrence of an `old_string` overlaps a compiler-owned region's markers or body.
- **Write:** the new `content` changes such a region's body, or drops its markers.
- **A Codex or OpenCode `apply_patch`:** any string field that holds `*** Begin Patch` text is read as its edits. An update hunk is checked like an Edit. A delete, a move, or an add over an existing file is checked like a Write.

To block, it exits 2 and prints one line on stderr naming the region and saying to edit its spec instead. Otherwise it exits 0 and prints nothing. It also exits 0 for invalid JSON, an unknown tool, a file outside the project, and a file with no compiler-owned region, so it never blocks what it doesn't understand.

It reads only the manifest and the edited file, runs no type check, and executes nothing from its input. It takes about 0.4 s, mostly Node's startup.

## Agents

`openarc setup` installs the guard hook and the skills for all three agents in one command, calling the project's `.openarc/bin/openarc` wrapper: see [[Setup]]. The table below is the plugins you install by hand.

All three integrations run the binary as `$OPENARC_BIN` when that variable is set, so a project doesn't need the package installed. Otherwise they use `node_modules/.bin/openarc`, then `openarc` on the `PATH`. They wire `guard --hook` only in a project with `openarc.config.json`. A missing binary or a failing guard never blocks an edit.

| Agent | Pre-edit hook |
|---|---|
| Claude Code | the plugin's `tool.call` hook on Edit, Write and MultiEdit denies the call with the guard's message |
| Codex | a `PreToolUse` command hook on `apply_patch\|Edit\|Write` in `hooks/hooks.json`. Exit 2 blocks the call |
| OpenCode | the plugin's `tool.execute.before` on `edit`, `write`, `multiedit` and `apply_patch` throws the message, which refuses the call |

The shared `openarc-sheet` skill tells the agent to compile with `prompt` and `accept`, and to retry at most twice.

To call the mode from your own skill or plugin, use the three commands with `--json`, and pass PreToolUse events to `openarc guard --hook`. Nothing else is needed.
