// Authoritative fake. All Ports in memory.
// init: { files?, http?: string[], proc?: [{ code, stdout, timedOut }], view?: string[] }
// snapshot(): { files, requests, runs } (requests never include postJson headers). now() is fixed; newTxId() yields tx1, tx2, ...
// With `view` (paths), snapshot() is a summary for end-to-end examples whose caches/manifests/sandbox paths vary by
// version: { files: only the listed paths that exist, requests: their urls, runs: each argv's program }.
import { defineFake, type Json } from "open-arc";
import type { Ports, ProcPort } from "../../src/types.ts";
import { memoryFs, sortedFiles } from "./fs.memory.ts";
import { stubHttp } from "./http.stub.ts";

type ProcResult = Awaited<ReturnType<ProcPort["run"]>>;

export default defineFake<Ports>((init) => {
  const i = (init ?? {}) as { files?: Record<string, string>; http?: string[]; proc?: ProcResult[]; view?: string[] };
  // The fake model server answers Ollama's /api/chat, so a project with no config gets an Ollama one (the built-in
  // default is llama-server). A test that passes its own openarc.config.json keeps it.
  const ollama = '{"version":1,"backends":{"local":{"provider":"ollama","model":"qwen3.5:9b","maxContextTokens":8192,"think":false}},"compilation":{"defaultBackend":"local","maxAttempts":3,"context":{"initialLevel":0,"expandOnFailure":true}}}\n';
  const { fs, files } = memoryFs({ files: { "openarc.config.json": ollama, ...i.files } });
  const hideDefault = (j: Json): Json =>
    Object.fromEntries(Object.entries(j as Record<string, string>).filter(([k, v]) => !(k === "openarc.config.json" && v === ollama && !i.files?.[k])));
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
  const view = i.view;
  const summary = (v: string[]) => ({
    files: Object.fromEntries(v.filter((f) => files.has(f)).sort().map((f) => [f, files.get(f)!])),
    requests: requests.map((r) => r.url),
    runs: runs.map((a) => a[0] ?? ""),
  });
  return { instance: ports, snapshot: () => (view ? summary(view) : { files: hideDefault(sortedFiles(files)), requests, runs }) };
});
