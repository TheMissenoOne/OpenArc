import * as arc from "open-arc";
import type { Command } from "./types.ts";

// ── cli.parseArgv ─────────────────────────────────────────────── spec §6.3
type ParseArgv = (argv: string[]) => Command;

export const parseArgvSpec = arc.defineRegion<ParseArgv>({
  id: "cli.parseArgv",
  intent: [
    "argv excludes 'node' and the script. Commands: init | compile [ids...] | scaffold | freeze <id> | release <id> | inspect <id> | graph",
    "| resolve <id> --keep|--regen|--unlink | extract <file> [--function <name>] [--id <id>] (flags in any order after the file; omit absent flags)",
    "| watch [--debounce <ms>] (debounceMs defaults to 300; the value must be a non-negative safe integer).",
    "Missing id -> usage missing-id; resolve without a mode -> usage resolve-needs-mode; extract without a file -> usage missing-file;",
    "extract or watch with an unknown flag or a flag without a valid value -> usage bad-flag; anything else -> usage unknown-command.",
  ],
  examples: [
    { args: [["compile"]], expected: { cmd: "compile", ids: [] } },
    { args: [["compile", "a.b", "c"]], expected: { cmd: "compile", ids: ["a.b", "c"] } },
    { args: [["scaffold"]], expected: { cmd: "scaffold" } },
    { args: [["init"]], expected: { cmd: "init" } },
    { args: [["freeze", "a"]], expected: { cmd: "freeze", id: "a" } },
    { args: [["release"]], expected: { cmd: "usage", reason: "missing-id" } },
    { args: [["resolve", "a", "--regen"]], expected: { cmd: "resolve", id: "a", mode: "regen" } },
    { args: [["resolve", "a"]], expected: { cmd: "usage", reason: "resolve-needs-mode" } },
    { args: [["graph"]], expected: { cmd: "graph" } },
    { args: [[]], expected: { cmd: "usage", reason: "unknown-command" } },
    { args: [["bogus"]], expected: { cmd: "usage", reason: "unknown-command" } },
    { args: [["extract", "src/a.ts"]], expected: { cmd: "extract", file: "src/a.ts" } },
    { args: [["extract", "src/a.ts", "--id", "a.g", "--function", "f"]], expected: { cmd: "extract", file: "src/a.ts", fn: "f", id: "a.g" } },
    { args: [["extract"]], expected: { cmd: "usage", reason: "missing-file" } },
    { args: [["extract", "src/a.ts", "--function"]], expected: { cmd: "usage", reason: "bad-flag" } },
    { args: [["extract", "src/a.ts", "--bogus", "x"]], expected: { cmd: "usage", reason: "bad-flag" } },
    { args: [["watch"]], expected: { cmd: "watch", debounceMs: 300 } },
    { args: [["watch", "--debounce", "50"]], expected: { cmd: "watch", debounceMs: 50 } },
    { args: [["watch", "--debounce"]], expected: { cmd: "usage", reason: "bad-flag" } },
    { args: [["watch", "--debounce", "soon"]], expected: { cmd: "usage", reason: "bad-flag" } },
    { args: [["watch", "--debounce", "99999999999999999999"]], expected: { cmd: "usage", reason: "bad-flag" } },
    { args: [["watch", "--bogus", "1"]], expected: { cmd: "usage", reason: "bad-flag" } },
  ],
});

// @openarc:begin cli.parseArgv
export const parseArgv: ParseArgv = (argv) => {
  if (argv.length === 0) {
    return { cmd: 'usage', reason: 'unknown-command' };
  }
  const [command, ...rest] = argv;
  switch (command) {
    case 'init':
      return { cmd: 'init' };

    case 'compile':
      return { cmd: 'compile', ids: rest };

    case 'scaffold':
      return { cmd: 'scaffold' };

    case 'freeze':
    case 'release':
    case 'inspect':
      if (rest.length === 0) {
        return { cmd: 'usage', reason: 'missing-id' };
      }
      return { cmd: command, id: rest[0] };

    case 'graph':
      return { cmd: 'graph' };

    case 'resolve':
      if (rest.length < 2) {
        return { cmd: 'usage', reason: 'resolve-needs-mode' };
      }
      const [id, mode] = rest;
      if (!['--keep', '--regen', '--unlink'].includes(mode)) {
        return { cmd: 'usage', reason: 'bad-flag' };
      }
      return { cmd: 'resolve', id, mode: mode.slice(2) as 'keep' | 'regen' | 'unlink' };

    case 'extract':
      if (rest.length === 0) {
        return { cmd: 'usage', reason: 'missing-file' };
      }
      const file = rest[0];
      const args = rest.slice(1);
      const result: { file: string; fn?: string; id?: string } = { file };

      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--function') {
          if (i + 1 >= args.length) return { cmd: 'usage', reason: 'bad-flag' };
          result.fn = args[++i];
        } else if (arg === '--id') {
          if (i + 1 >= args.length) return { cmd: 'usage', reason: 'bad-flag' };
          result.id = args[++i];
        } else {
          return { cmd: 'usage', reason: 'bad-flag' };
        }
      }
      return { cmd: 'extract', ...result };

    case 'watch':
      let debounceMs = 300;
      if (rest.length > 0) {
        if (rest[0] !== '--debounce') {
          return { cmd: 'usage', reason: 'bad-flag' };
        }
        if (rest.length < 2) {
          return { cmd: 'usage', reason: 'bad-flag' };
        }
        const value = rest[1];
        if (!/^\d+$/.test(value) || Number(value) > Number.MAX_SAFE_INTEGER) {
          return { cmd: 'usage', reason: 'bad-flag' };
        }
        debounceMs = Number(value);
      }
      return { cmd: 'watch', debounceMs };

    default:
      return { cmd: 'usage', reason: 'unknown-command' };
  }
};
// @openarc:end cli.parseArgv
