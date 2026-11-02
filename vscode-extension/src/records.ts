// Pure readers for what the CLI leaves on disk or prints. No vscode import, so test/records.check.mjs runs it in Node.

/** One line of .openarc/watch-history.jsonl (stage0 watcher.ts `record`). */
export interface HistoryEntry { at: string; id: string; state: "running" | "done" | "failed" | "requeued" | "interrupted"; ms: number; detail: string }

/** The last record of each region, in file order. A torn line (a crash mid-write) is skipped, as the watcher does. */
export function lastPerRegion(text: string): Map<string, HistoryEntry> {
  const last = new Map<string, HistoryEntry>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as HistoryEntry;
      if (typeof e.id === "string" && typeof e.state === "string") { last.delete(e.id); last.set(e.id, e); }
    } catch { /* torn line */ }
  }
  return last;
}

/** `openarc graph` lines: `<indent><id> F|B <display state> <n> ex ... <file>`. Only the display state is kept. */
export function parseGraph(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*([a-z][a-zA-Z0-9.]*)\s+[FB]\s+(\w+)\s/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/** `openarc lint --format json` (stage0 lint.ts Finding). Anything that is not that array (an older CLI without lint) is []. */
export interface Finding { rule: string; severity: "warn" | "error"; id: string; file: string; line: number; message: string }
export function parseLint(stdout: string): Finding[] {
  try {
    const v: unknown = JSON.parse(stdout);
    return Array.isArray(v) ? v.filter((f) => f && typeof f.rule === "string" && typeof f.id === "string") : [];
  } catch {
    return [];
  }
}

/** The OARC code a watch/failed detail starts with ("OARC-E098 engine.parse" -> "OARC-E098"). */
export const codeOf = (detail: string): string | undefined => /^OARC-[EW]\d{3}\b/.exec(detail)?.[0];

/** SPEC-phase0 §17 wording for the codes the extension surfaces from compile results. */
export const MESSAGES: Record<string, string> = {
  "OARC-W043": "region keeps a body that does not satisfy its current spec (its compile failed; shown as stale)",
  "OARC-W044": "thin examples: fewer than 3, or none with an edge case; passing them proves little (openarc check <id> --oracle)",
  "OARC-W045": "region unverified: no passing example or test reaches it (not committed)",
  "OARC-E098": "call not allowed by the spec's `calls` list",
  "OARC-E082": "attempts exhausted",
};

/** A path or `<module>#<export>` that can go on any shell's command line unquoted (cmd.exe, PowerShell, sh).
 *  ponytail: a path with spaces is refused instead of quoted per shell. */
export const safeArg = (s: string): boolean => /^[\w@./+-]+(#[\w$]+)?$/.test(s);
