// The evolve-multi scenario and its plain-prompt arm (D), shared by evolve-multi.mjs and arc-tokens.mjs.
// ctx: { dataset, splits, backend, port, model, seed, oaModules }
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXERCISES, instructions, heldOut, runTests, exampleLine, exampleTest } from "./common.mjs";
import { sketchFile } from "./adapter.mjs";
import { chat, extractCode } from "./baseline.mjs";

export const INTENT_CHANGE = "Return a new value and never mutate the input.";
export const HAND = `// hand-written: fill ring by ring
  const m: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  let n = 1;
  for (let ring = 0; ring < Math.ceil(size / 2); ring++) {
    const last = size - 1 - ring;
    for (let c = ring; c <= last; c++) m[ring]![c] = n++;
    for (let r = ring + 1; r <= last; r++) m[r]![last] = n++;
    for (let c = last - 1; c >= ring && last > ring; c--) m[last]![c] = n++;
    for (let r = last - 1; r > ring && last > ring; r--) m[r]![ring] = n++;
  }
  return m;`;
export const SCENARIO = [
  { name: "create text.ts and arrays.ts", add: { text: ["acronym", "diamond"], arrays: ["flatten-array", "binary-search"] } },
  { name: "add codec.ts", add: { codec: ["variable-length-quantity"] } },
  { name: "add transpose to arrays.ts", add: { arrays: ["transpose"] } },
  { name: "change flatten intent", intent: "flatten-array" },
  { name: "add grid.ts", add: { grid: ["spiral-matrix"] } },
  { name: "hand-edit ofSize, add rectangles", hand: true, add: { grid: ["rectangles"] } },
  { name: "add wordy to text.ts", add: { text: ["wordy"] } },
  { name: "change binary-search intent", intent: "binary-search" },
  { name: "no change", none: true },
];

export const fnsOf = (ex) => Object.keys(EXERCISES.functions[ex].fns);
export const fileOf = (layout, ex) => Object.keys(layout).find((f) => layout[f].includes(ex));
/** files the step touches: the files it adds to, the file of a changed intent, the file of the hand edit */
export const touched = (st, layout) => [...new Set([...Object.keys(st.add ?? {}), ...(st.intent ? [fileOf(layout, st.intent)] : [])])];
export const grow = (layout, add) => { for (const [f, exs] of Object.entries(add ?? {})) layout[f] = [...(layout[f] ?? []), ...exs]; };
export const handPresent = (src) => src.replace(/\s+/g, " ").includes(HAND.replace(/\s+/g, " "));
/** The hand edit on a plain file: ofSize's body becomes HAND. */
export const applyHand = (src) => src.replace(/export (?:function ofSize\([^)]*\)[^{]*|const ofSize[^=]*=\s*\([^)]*\)[^{]*)\{[\s\S]*?\n\}/, `export function ofSize(size: number): number[][] {\n  ${HAND}\n}`);
export const memAvailMb = () => +readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1] / 1024;

/** Token meter: a proxy on `port` to the backend's origin; onUsage gets every chat completion's JSON (OpenAI-compatible usage). */
export function meterProxy(backend, port, onUsage) {
  return createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const up = await fetch(new URL(backend.baseUrl).origin + req.url, { method: req.method, headers: { "content-type": "application/json", ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) }, body: req.method === "GET" ? undefined : Buffer.concat(chunks) });
      const text = await up.text();
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }).end(text);
      if (/\/chat\/completions/.test(req.url)) try { onUsage(JSON.parse(text)); } catch {}
    } catch (e) { if (!res.headersSent) res.writeHead(502); res.end(String(e)); }
  }).listen(port, "127.0.0.1");
}

/** held-out per exercise, against its file through a re-export */
export async function score(ctx, dir, layout, path) {
  const out = {};
  for (const [f, exs] of Object.entries(layout)) for (const ex of exs) {
    const h = await heldOut(ctx.dataset, ex, join(dir, "heldout", ex), `export * from ${JSON.stringify(path(f))};\n`, ctx.splits[ex], { "open-arc": join(ctx.oaModules, "open-arc") });
    out[ex] = { passed: h.passed, total: h.total, allPass: h.allPass, publicPass: h.publicPass, loadError: h.loadError?.slice(0, 300) };
  }
  return out;
}

export const SYSTEM = "You are an expert TypeScript programmer. Reply with the complete TypeScript file in a single ```ts code block and nothing else.";
const examplesOf = (ctx, ex) => fnsOf(ex).flatMap((f) => ctx.splits[ex].examples[f].map((e) => exampleLine(f, e))).join("\n");
export const sigOf = (ex) => { const e = EXERCISES.functions[ex]; return `${e.types ? e.types + "\n\n" : ""}${fnsOf(ex).map((f) => { const [, p, r] = e.fns[f].match(/^\((.*)\) => (.*)$/); return `export function ${f}(${p}): ${r}`; }).join("\n")}`; };
export function changeText(ctx, st, f, layout, cfg = {}) {
  const parts = [];
  for (const ex of st.add?.[f] ?? []) parts.push(`Add ${fnsOf(ex).map((x) => `\`${x}\``).join(" and ")} (exercise "${ex}"):\n\n${instructions(ctx.dataset, ex)}\n\nSignature:\n\n\`\`\`ts\n${sigOf(ex)}\n\`\`\`\n\nExamples that must hold:\n${examplesOf(ctx, ex)}${cfg.sketch ? outline(ex) : ""}`);
  if (st.intent && fileOf(layout, st.intent) === f) parts.push(`Change ${fnsOf(st.intent).map((x) => `\`${x}\``).join(" and ")}: ${INTENT_CHANGE}`);
  return parts.join("\n\n");
}
// the C-sketch outline for the plain prompt: the same sketch file, arc.hole("...") read as "fill in: ..."
const outline = (ex) => { const s = fnsOf(ex).filter((f) => existsSync(sketchFile(ex, f))).map((f) => `\`${f}\` = ${readFileSync(sketchFile(ex, f), "utf8").trim()}`); return s.length ? `\n\nImplementation outline (each arc.hole("...") is a gap you fill as described):\n\n\`\`\`ts\n${s.join("\n\n")}\n\`\`\`` : ""; };
export const publicTests = (ctx, f, exs) => {
  const dec = `const d = (v: any): any => v === "$undefined" ? undefined : v === "$NaN" ? NaN : v === "$Infinity" ? Infinity : v === "$-Infinity" ? -Infinity : Array.isArray(v) ? v.map(d) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, d(x)])) : v;\n`;
  let s = `import { it, expect } from '@jest/globals'\nimport * as m from './${f}.ts'\n${dec}`;
  for (const ex of exs) for (const fn of fnsOf(ex)) for (const e of ctx.splits[ex].examples[fn]) s += exampleTest(fn, e);
  return s;
};

/** The first user message D sends for file `f` (null when the step does not touch it). */
export const askD = (ctx, st, f, layout, code, cfg = {}) => code[f]
  ? `Current file \`${f}.ts\`:\n\n\`\`\`ts\n${code[f]}\n\`\`\`\n\n${changeText(ctx, st, f, layout, cfg)}\n\nKeep everything else unchanged. Return the complete file.`
  : `Write the TypeScript file \`${f}.ts\`.\n\n${changeText(ctx, st, f, layout, cfg)}\n\nReturn the complete file.`;

/** One step of D: for each file the step touches, a fresh chat with the current file and the change, the complete file
 *  back, up to 3 attempts with that file's failing public examples as feedback. Updates `code`, writes every file to dir. */
export async function stepD(ctx, dir, st, layout, code, cfg = {}) {
  const path = (f) => join(dir, `${f}.ts`);
  let attempts = 0, publicPass = true;
  if (!st.none) for (const f of touched(st, layout)) {
    const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: askD(ctx, st, f, layout, code, cfg) }];
    await writeFile(join(dir, `${f}.public.test.ts`), publicTests(ctx, f, layout[f]));
    const total = layout[f].reduce((n, ex) => n + fnsOf(ex).reduce((k, fn) => k + ctx.splits[ex].examples[fn].length, 0), 0);
    let ok = false;
    for (let i = 1; i <= 3 && !ok; i++) {
      attempts++;
      const reply = await chat(ctx.backend, ctx.port, ctx.model, messages, { seed: ctx.seed, temperature: 0 });
      const next = extractCode(reply);
      await writeFile(path(f), next);
      const pt = await runTests(join(dir, `${f}.public.test.ts`));
      const failed = pt.lines.filter((l) => !l.ok);
      ok = pt.lines.length === total && !failed.length;
      if (ok || i === 3) code[f] = next;
      if (!ok) messages.push({ role: "assistant", content: reply }, { role: "user", content: `The file fails these examples:\n${pt.lines.length ? failed.map((l) => `- ${l.name}: ${l.msg}`).join("\n").slice(0, 3000) : `The file did not load:\n${pt.stderr.split("\n").filter(Boolean).slice(-8).join("\n")}`}\n\nFix it and return the complete corrected file.` });
    }
    publicPass &&= ok;
  }
  for (const [f, c] of Object.entries(code)) await writeFile(path(f), c);
  return { attempts, publicPass };
}
