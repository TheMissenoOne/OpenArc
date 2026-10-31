// Authoritative fake. All Ports in memory.
// init: { files?, http?: string[], proc?: [{ code, stdout, timedOut }] }
// snapshot(): { files, requests, runs } (requests never include postJson headers). now() is fixed; newTxId() yields tx1, tx2, ...
import { defineFake, type Json } from "@openarc/core";
import type { Ports, ProcPort } from "../../src/types.ts";
import { memoryFs, sortedFiles } from "./fs.memory.ts";
import { stubHttp } from "./http.stub.ts";

type ProcResult = Awaited<ReturnType<ProcPort["run"]>>;

export default defineFake<Ports>((init) => {
  const i = (init ?? {}) as { files?: Record<string, string>; http?: string[]; proc?: ProcResult[] };
  const { fs, files } = memoryFs({ files: i.files ?? {} });
  const { http, requests } = stubHttp({ responses: i.http ?? [] });
  const procQueue = [...(i.proc ?? [])];
  const runs: string[][] = [];
  let tx = 0;
  const ports: Ports = {
    fs,
    http,
    proc: {
      async run(argv) {
        runs.push(argv);
        const r = procQueue.shift();
        if (r === undefined) throw new Error("ports.memory: no proc result left");
        return r;
      },
    },
    now: () => "2026-01-01T00:00:00.000Z",
    newTxId: () => `tx${++tx}`,
    log: () => {},
  };
  return { instance: ports, snapshot: () => ({ files: sortedFiles(files), requests, runs }) };
});
