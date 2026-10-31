import * as arc from "openarc";
import type { FsPort, Journal } from "./types.ts";

// ── txn.planJournal ───────────────────────────────────────────── spec §8.1 STAGE
type PlanJournal = (txid: string, files: { target: string; staged: string }[]) => Journal;

export const planJournalSpec = arc.defineRegion<PlanJournal>({
  id: "txn.planJournal",
  intent: "One entry per file, in input order; backup path is .openarc/txn/<txid>/backup/<index>.",
  examples: [
    { args: ["t1", []], expected: { txid: "t1", entries: [] } },
    {
      args: ["t1", [
        { target: "src/a.ts", staged: ".openarc/txn/t1/stage/0" },
        { target: ".openarc/manifest.json", staged: ".openarc/txn/t1/stage/1" },
      ]],
      expected: {
        txid: "t1",
        entries: [
          { target: "src/a.ts", staged: ".openarc/txn/t1/stage/0", backup: ".openarc/txn/t1/backup/0" },
          { target: ".openarc/manifest.json", staged: ".openarc/txn/t1/stage/1", backup: ".openarc/txn/t1/backup/1" },
        ],
      },
    },
  ],
});

// @openarc:begin txn.planJournal
export const planJournal: PlanJournal = (txid, files) => arc.todo("txn.planJournal");
// @openarc:end txn.planJournal

// ── txn.commit / txn.recover ──────────────────────────────────── spec §8.1 COMMIT, §8.2
// Effectful: FsPort comes in as a fake (spec §9.4, F6).
type Commit = (fs: FsPort, journal: Journal) => Promise<void>;
type Recover = (fs: FsPort) => Promise<string[]>;

export const commitSpec = arc.defineRegion<Commit>({
  id: "txn.commit",
  intent: [
    "Write JSON.stringify(journal) to .openarc/txn/<txid>/journal.json FIRST.",
    "Then per entry, in order: if target exists, write its content to backup, else write '' to backup + '.absent'; then rename staged over target.",
    "Finally remove .openarc/txn/<txid>. Callers put the manifest last, so a crash never leaves a manifest describing files that were not written.",
  ],
  examples: [
    {
      args: [
        { $fake: "fs.memory", init: { files: { "src/a.ts": "old", ".openarc/txn/t1/stage/0": "new", ".openarc/txn/t1/stage/1": "{}" } } },
        {
          txid: "t1",
          entries: [
            { target: "src/a.ts", staged: ".openarc/txn/t1/stage/0", backup: ".openarc/txn/t1/backup/0" },
            { target: ".openarc/manifest.json", staged: ".openarc/txn/t1/stage/1", backup: ".openarc/txn/t1/backup/1" },
          ],
        },
      ],
      fakesAfter: { "fs.memory": { files: { ".openarc/manifest.json": "{}", "src/a.ts": "new" } } },
    },
  ],
});

// @openarc:begin txn.commit
export const commit: Commit = (fs, journal) => arc.todo("txn.commit");
// @openarc:end txn.commit

export const recoverSpec = arc.defineRegion<Recover>({
  id: "txn.recover",
  intent: [
    "For every directory under .openarc/txn (sorted) that has journal.json: for each entry, if backup exists write it over target;",
    "else if backup + '.absent' exists remove target (it was a new file); else leave target untouched (entry never started).",
    "Then remove the txn directory. Return the recovered txids.",
  ],
  examples: [
    { name: "nothing to recover", args: [{ $fake: "fs.memory", init: { files: { "src/a.ts": "x" } } }], expected: [], fakesAfter: { "fs.memory": { files: { "src/a.ts": "x" } } } },
    {
      name: "crash after entry 1 of 3",
      args: [{
        $fake: "fs.memory",
        init: {
          files: {
            ".openarc/txn/t9/journal.json": '{"txid":"t9","entries":[{"target":"src/a.ts","staged":".openarc/txn/t9/stage/0","backup":".openarc/txn/t9/backup/0"},{"target":"src/b.ts","staged":".openarc/txn/t9/stage/1","backup":".openarc/txn/t9/backup/1"},{"target":"src/c.ts","staged":".openarc/txn/t9/stage/2","backup":".openarc/txn/t9/backup/2"}]}',
            ".openarc/txn/t9/backup/0": "original",
            ".openarc/txn/t9/backup/1.absent": "",
            ".openarc/txn/t9/stage/2": "never-applied",
            "src/a.ts": "half",
            "src/b.ts": "new-file",
            "src/c.ts": "untouched",
          },
        },
      }],
      expected: ["t9"],
      fakesAfter: { "fs.memory": { files: { "src/a.ts": "original", "src/c.ts": "untouched" } } },
    },
  ],
});

// @openarc:begin txn.recover
export const recover: Recover = (fs) => arc.todo("txn.recover");
// @openarc:end txn.recover
