# MCP

`openarc mcp` serves OpenArc's commands as typed tools over the Model Context Protocol, on stdio. An agent or another plugin can then call OpenArc without loading its skill or parsing terminal text. [[Setup]] registers it for Claude Code, Codex and OpenCode.

Each tool call runs the OpenArc CLI in a child process: the same `node` and `main` the server runs from, in the tool's `root` folder (default: the folder the server was started in), with a 120 s limit. The result is the command's stdout, its `--json` output where it has one. A non-zero exit sets `isError: true` and adds stderr and the exit code. The server calls no model.

## Tools

Every tool also takes `root`, the project folder.

| Tool | Runs | Input |
|---|---|---|
| `status` | `status --json [--part p] [--goal g]` | `part`, `goal` |
| `decompile_report` | `decompile --report` (text: its `--json` is the whole state) | |
| `decompile_todo` | `decompile --todo --json` | |
| `decompile_check` | `decompile --check --json [dirs...]` | `dirs` |
| `arch` | `arch --json [dirs...]`, writes `arc/architecture.arc` | `dirs` |
| `arch_check` | `arch --check --json [dirs...]` | `dirs` |
| `concept` | `concept --json`, writes `arc/concept.arc` | |
| `concept_check` | `concept --check --json` | |
| `inspect` | `inspect <id>` | `id` |
| `guard` | `guard --hook` with the edit on stdin: refused (`isError`, the reason) or `ok` | `file`, and `old_string` (an edit) or `content` (a whole-file write) |
| `prompt` | `prompt <id> --json` | `id` |
| `accept` | `accept <id> --json`, `body` on stdin | `id`, `body` |
| `arc_status` | `arc status [name] --json` | `name` (a module or `module.fn`, optional) |
| `arc_prompt` | `arc prompt <name> --json` | `name` |
| `arc_accept` | `arc accept <name> --json`, `body` on stdin | `name`, `body` |

Not exposed: `setup`, `decompile` without a flag (it writes many files and can run long), and anything that calls a model. A value that would land as a positional argument may not start with `-`.

To add a tool, add one row to `TOOLS` in `stage0/src/mcp.ts`: `name`, `description`, `inputSchema`, `argv(input)`, and `stdin(input)` when the command reads stdin.

## Protocol

Newline-delimited JSON-RPC 2.0. Nothing but protocol messages goes to stdout; the child's output stays inside tool results.

- Legacy clients (`initialize`, revisions 2025-11-25 back to 2024-11-05): the server answers with the client's version if it is one of those, else 2025-11-25, and `capabilities: { tools: {} }`. `notifications/initialized` is accepted and not answered.
- Modern clients (2026-07-28, per-request `_meta`): `server/discover`, and every result carries `resultType: "complete"`. An unknown `io.modelcontextprotocol/protocolVersion` gets error `-32022` with the supported list; a 2026-07-28 request without `io.modelcontextprotocol/clientCapabilities` gets `-32602`.
- Also `ping`, `tools/list`, `tools/call` and `notifications/cancelled` (kills the child, no reply). A line that is not JSON gets `-32700`, a batch or a malformed message `-32600`, an unknown method `-32601`, an unknown tool `-32602`. Bad tool arguments are a tool result with `isError: true`.
- The server exits when stdin closes.

## Registering by hand

Use the project's wrapper, `.openarc/bin/openarc`, which [[Setup]] writes. Setup writes exactly these, with `cd <project> &&` before `exec` when the project is below the repository root:

Claude Code, `.mcp.json` at the repository root (Claude Code asks before it starts a project server):

```json
{ "mcpServers": { "openarc": { "type": "stdio", "command": "sh", "args": ["-c", "cd \"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\" && exec .openarc/bin/openarc mcp"] } } }
```

OpenCode, `opencode.json` at the repository root:

```json
{ "mcp": { "openarc": { "type": "local", "command": ["sh", "-c", "cd \"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\" && exec .openarc/bin/openarc mcp"], "enabled": true } } }
```

Codex, `.codex/config.toml` at the repository root (read only in a trusted project):

```toml
[mcp_servers.openarc]
command = "sh"
args = ["-c", "cd \"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\" && exec .openarc/bin/openarc mcp"]
tool_timeout_sec = 120
```

Without git at the root, drop the first `cd`: the command then runs from wherever the agent starts it.

## What was checked

On 2026-11-12, on a tree `openarc setup` wrote with the project in a subfolder: OpenCode 1.19.5 `opencode mcp list` started the server and showed it `connected`; Claude Code 2.1.323 `claude mcp get openarc` read `.mcp.json` (status: pending approval, so it was not started); Codex 0.163.0 `config/read` over `codex app-server`, with a throwaway `CODEX_HOME` that trusts the folder, returned the `openarc` server from the project layer. No model session was started, so no agent called a tool.
