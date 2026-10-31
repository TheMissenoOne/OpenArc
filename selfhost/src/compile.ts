import * as arc from "open-arc";
import type { Candidate, CompileRequest, CompileResult, Diagnostic, Ports, StagedFile } from "./types.ts";
import * as engine from "./engine.ts";
import { planJournal, commit, recover } from "./txn.ts";

const hasErrors = (ds: Diagnostic[]) => ds.some((d) => d.code.startsWith("OARC-E"));

// ── compile.run ───────────────────────────────────────────────── spec §8
// MIXED RESOLUTION. The parent body below is hand-written control flow (state = developer,
// because it has markers but no manifest entry). Each step is a PENDING block region that
// OpenArc generates independently. Blocks talk to the parent only through the `let`s
// declared above them (§3.4). Every early exit is a `return` in the parent, never in a block.
// The heavy lifting lives in ./engine.ts (hand-written), so each block is a short orchestration step.
type Run = (ports: Ports, req: CompileRequest) => Promise<CompileResult>;

export const runSpec = arc.defineRegion<Run>({
  id: "compile.run",
  intent: "One compile transaction (§8). Disk is untouched unless every target passes STATIC and SANDBOX.",
  examples: [
    {
      name: "lock held by another run",
      args: [
        { $fake: "ports.memory", init: { files: { ".openarc/lock": "" } } },
        { root: "/p", ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 2048 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 4294967296, cpuSeconds: 10 } },
      ],
      expected: { exit: 1, diagnostics: [{ code: "OARC-E095" }], modelCalls: 0 },
      fakesAfter: { "ports.memory": { files: { ".openarc/lock": "" }, requests: [], runs: [] } },
    },
    {
      name: "empty project: nothing to do, lock released",
      args: [
        { $fake: "ports.memory", init: { files: { ".openarc/manifest.json": '{"schema":1,"regions":{}}' } } },
        { root: "/p", ids: [], model: { host: "http://h", model: "m", seed: 1, numCtx: 2048 }, sandbox: { nodeBin: "/n/bin/node", nodePrefix: "/n", heapMb: 256, addressSpaceBytes: 4294967296, cpuSeconds: 10 } },
      ],
      expected: { exit: 0, diagnostics: [], modelCalls: 0 },
      fakesAfter: { "ports.memory": { files: { ".openarc/manifest.json": '{"schema":1,"regions":{}}' }, requests: [], runs: [] } },
    },
  ],
});

export const lockSpec = arc.defineBlock({
  id: "compile.run.lock",
  intent: "locked = await ports.fs.createExclusive('.openarc/lock'); if it returned false, push { code: 'OARC-E095' } to diagnostics.",
});
export const recoverStepSpec = arc.defineBlock({
  id: "compile.run.recover",
  intent: "For each txid returned by await recover(ports.fs), push { code: 'OARC-W094', detail: txid } to diagnostics.",
});
export const parseStepSpec = arc.defineBlock({
  id: "compile.run.parse",
  intent: "project = await engine.parse(ports, req, diagnostics);",
});
export const analyzeStepSpec = arc.defineBlock({
  id: "compile.run.analyze",
  intent: "If project is not null: await engine.analyze(ports, req, project, diagnostics).",
});
export const planStepSpec = arc.defineBlock({
  id: "compile.run.plan",
  intent: "If project is not null: targets = engine.plan(project, req, diagnostics).",
});
export const generateStepSpec = arc.defineBlock({
  id: "compile.run.generate",
  intent: "If project is not null: const r = await engine.generate(ports, req, project, id, diagnostics); then set candidate = r.candidate and add r.modelCalls to modelCalls.",
});
export const stageStepSpec = arc.defineBlock({
  id: "compile.run.stage",
  intent: "If project is not null: staged = await engine.stage(ports, req, project, candidates, txid, diagnostics).",
});
export const commitStepSpec = arc.defineBlock({
  id: "compile.run.commit",
  intent: "await commit(ports.fs, planJournal(txid, staged.map((f, i) => ({ target: f.target, staged: `.openarc/txn/${txid}/stage/${i}` })))).",
});
export const unlockSpec = arc.defineBlock({
  id: "compile.run.unlock",
  intent: "await ports.fs.remove('.openarc/lock').",
});

// @openarc:begin compile.run
export async function run(ports: Ports, req: CompileRequest): Promise<CompileResult> {
  const diagnostics: Diagnostic[] = [];
  const txid = ports.newTxId();
  let locked = false;
  let project: engine.Project | null = null;
  let targets: string[] = [];
  const candidates: Candidate[] = [];
  let staged: StagedFile[] = [];
  let modelCalls = 0;
  const done = (exit: 0 | 1): CompileResult => ({ exit, diagnostics, modelCalls });

  // @openarc:begin compile.run.lock
  arc.pending("compile.run.lock");
  // @openarc:end compile.run.lock
  if (!locked) return done(1);

  try {
    // @openarc:begin compile.run.recover
    arc.pending("compile.run.recover");
    // @openarc:end compile.run.recover

    // @openarc:begin compile.run.parse
    arc.pending("compile.run.parse");
    // @openarc:end compile.run.parse
    if (hasErrors(diagnostics)) return done(1);

    // @openarc:begin compile.run.analyze
    arc.pending("compile.run.analyze");
    // @openarc:end compile.run.analyze
    if (hasErrors(diagnostics)) return done(1);

    // @openarc:begin compile.run.plan
    arc.pending("compile.run.plan");
    // @openarc:end compile.run.plan
    if (targets.length === 0 && (project === null || !engine.manifestChanged(project))) return done(hasErrors(diagnostics) ? 1 : 0);

    for (const id of targets) {
      let candidate: Candidate | null = null;
      // @openarc:begin compile.run.generate
      arc.pending("compile.run.generate");
      // @openarc:end compile.run.generate
      if (candidate === null) {
        if (!req.keepGoing) return done(1); // nothing staged yet → disk untouched
        continue;
      }
      candidates.push(candidate);
    }

    // @openarc:begin compile.run.stage
    arc.pending("compile.run.stage");
    // @openarc:end compile.run.stage
    if (staged.length === 0) return done(1);

    // @openarc:begin compile.run.commit
    arc.pending("compile.run.commit");
    // @openarc:end compile.run.commit
    return done(hasErrors(diagnostics) ? 1 : 0);
  } finally {
    // @openarc:begin compile.run.unlock
    arc.pending("compile.run.unlock");
    // @openarc:end compile.run.unlock
  }
}
// @openarc:end compile.run
