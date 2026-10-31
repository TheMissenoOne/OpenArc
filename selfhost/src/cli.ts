import * as arc from "openarc";
import type { Command } from "./types.ts";

// ── cli.parseArgv ─────────────────────────────────────────────── spec §6.3
type ParseArgv = (argv: string[]) => Command;

export const parseArgvSpec = arc.defineRegion<ParseArgv>({
  id: "cli.parseArgv",
  intent: [
    "argv excludes 'node' and the script. Commands: init | compile [ids...] | scaffold | freeze <id> | release <id> | inspect <id> | graph",
    "| resolve <id> --keep|--regen|--unlink. Missing id -> usage missing-id; resolve without a mode -> usage resolve-needs-mode; anything else -> usage unknown-command.",
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
  ],
});

// @openarc:begin cli.parseArgv
export const parseArgv: ParseArgv = (argv) => {
  const [cmd, ...rest] = argv;
  if (cmd === "compile") {
    return { cmd: "compile", ids: rest };
  }
  if (cmd === "scaffold") {
    return { cmd: "scaffold" };
  }
  if (cmd === "init") {
    return { cmd: "init" };
  }
  if (cmd === "freeze" || cmd === "release" || cmd === "inspect") {
    if (rest.length === 0) {
      return { cmd: "usage", reason: "missing-id" };
    }
    return { cmd, id: rest[0] };
  }
  if (cmd === "graph") {
    return { cmd: "graph" };
  }
  if (cmd === "resolve") {
    if (rest.length === 0) {
      return { cmd: "usage", reason: "missing-id" };
    }
    const id = rest[0];
    const modeFlag = rest.slice(1).find((f) => f.startsWith("--"));
    if (!modeFlag) {
      return { cmd: "usage", reason: "resolve-needs-mode" };
    }
    const mode = modeFlag.replace("--", "");
    if (mode !== "keep" && mode !== "regen" && mode !== "unlink") {
      return { cmd: "usage", reason: "unknown-command" };
    }
    return { cmd: "resolve", id, mode };
  }
  return { cmd: "usage", reason: "unknown-command" };
};
// @openarc:end cli.parseArgv
