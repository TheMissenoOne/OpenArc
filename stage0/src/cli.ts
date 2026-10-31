import * as arc from "@openarc/core";
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
  const [c, ...rest] = argv;
  switch (c) {
    case "compile":
      return { cmd: "compile", ids: rest };
    case "scaffold":
    case "graph":
    case "init":
      return { cmd: c };
    case "freeze":
    case "release":
    case "inspect":
      return rest[0] ? { cmd: c, id: rest[0] } : { cmd: "usage", reason: "missing-id" };
    case "resolve": {
      if (!rest[0]) return { cmd: "usage", reason: "missing-id" };
      const mode = rest[1]?.replace(/^--/, "");
      return mode === "keep" || mode === "regen" || mode === "unlink"
        ? { cmd: "resolve", id: rest[0], mode }
        : { cmd: "usage", reason: "resolve-needs-mode" };
    }
    case "extract": {
      const [file, ...flags] = rest;
      if (!file) return { cmd: "usage", reason: "missing-file" };
      const out: Command = { cmd: "extract", file };
      for (let i = 0; i < flags.length; i += 2) {
        const v = flags[i + 1];
        if (v === undefined || (flags[i] !== "--function" && flags[i] !== "--id")) return { cmd: "usage", reason: "bad-flag" };
        if (flags[i] === "--function") out.fn = v;
        else out.id = v;
      }
      return out;
    }
    case "watch": {
      if (rest.length === 0) return { cmd: "watch", debounceMs: 300 };
      const ms = rest[1] !== undefined && /^\d+$/.test(rest[1]) ? Number(rest[1]) : NaN;
      return rest[0] === "--debounce" && rest.length === 2 && Number.isSafeInteger(ms) ? { cmd: "watch", debounceMs: ms } : { cmd: "usage", reason: "bad-flag" };
    }
    default:
      return { cmd: "usage", reason: "unknown-command" };
  }
};
// @openarc:end cli.parseArgv
