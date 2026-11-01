// Config D: conventional whole-file prompting through the same Ollama model, same examples, same retry budget.
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RESAMPLE_TEMPERATURE } from "./adapter.mjs";
import { EXERCISES, instructions, typedStub, heldOut, runTests, prepareTestDir, proxyBase } from "./common.mjs";

const SYSTEM = "You are an expert TypeScript programmer. Reply with the complete TypeScript file in a single ```ts code block and nothing else.";
const show = (v) => JSON.stringify(v);

export function baselinePrompt(dataset, ex, splitInfo) {
  const ex_ = Object.entries(splitInfo.examples).flatMap(([f, es]) => es.map((e) => `- ${f}(${e.args.map(show).join(", ")}) returns ${show(e.expected)}`));
  return [
    `Exercise "${ex}". Instructions:\n\n${instructions(dataset, ex)}`,
    `Stub file \`${ex}.ts\`:\n\n\`\`\`ts\n${typedStub(ex)}\`\`\``,
    `Examples that must hold (the strings "$undefined", "$NaN", "$Infinity" stand for those values):\n${ex_.join("\n")}`,
    `Implement every exported function. Keep the exported names and type signatures. Return the complete file.`,
  ].join("\n\n");
}

export function extractCode(text) {
  const blocks = [...text.matchAll(/```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) return blocks.sort((a, b) => b.length - a.length)[0];
  return text.replace(/^```\w*\n?|```\s*$/g, "");
}

/** Public examples as a jest-style test file (same examples OpenArc verifies). */
function publicTest(ex, splitInfo) {
  const dec = `const d = (v: any): any => v === "$undefined" ? undefined : v === "$NaN" ? NaN : v === "$Infinity" ? Infinity : v === "$-Infinity" ? -Infinity : Array.isArray(v) ? v.map(d) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, d(x)])) : v;\n`;
  let s = `import { it, expect } from '@jest/globals'\nimport * as m from './${ex}.ts'\n${dec}`;
  for (const [f, es] of Object.entries(splitInfo.examples))
    for (const e of es) s += `it(${show(`${f}: ${e.name}`)}, () => { expect((m as any).${f}(...d(${show(e.args)}))).toEqual(d(${show(e.expected)})) })\n`;
  return s;
}

/**
 * One chat call through the proxy, with the same sampling OpenArc sends to that provider (temperature 0, seed 1, the
 * same output cap); OpenArc's structured-output schema is the only request difference. Returns the reply text.
 */
async function chat(backend, port, model, messages, { seed = 1, temperature = 0 } = {}) {
  const base = proxyBase(backend, port);
  if (backend.provider === "ollama") {
    const r = await fetch(`${base}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, think: false, keep_alive: "2m", messages, options: { temperature, seed, num_ctx: backend.maxContextTokens, num_predict: backend.outputReserveTokens } }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).message?.content ?? "";
  }
  const headers = { "content-type": "application/json" };
  if (backend.apiKeyEnv && process.env[backend.apiKeyEnv]) headers.authorization = `Bearer ${process.env[backend.apiKeyEnv]}`;
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST", headers,
    body: JSON.stringify({ model, temperature, seed, max_tokens: backend.outputReserveTokens, messages,
      ...(backend.info?.engine === "ollama" ? { keep_alive: "2m", reasoning_effort: "none" } : {}) }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).choices?.[0]?.message?.content ?? "";
}

/**
 * Repair (default): each retry appends the reply and the failing public-example output to the conversation.
 * Resample (`cfg.resample`, E-resample): each attempt is a fresh conversation with no feedback; attempt 1 is temperature
 * 0 and the run's seed, attempts 2 and 3 use RESAMPLE_TEMPERATURE and seed + attempt - 1 (the same schedule as OpenArc's).
 */
export async function runBaseline({ dataset, ex, splitInfo, model, dir, port, backend, cfg = {}, seed = 1, maxAttempts = 3 }) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await prepareTestDir(dir);
  await writeFile(join(dir, "public.test.ts"), publicTest(ex, splitInfo));
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: baselinePrompt(dataset, ex, splitInfo) }];
  const tries = [];
  let code = typedStub(ex), ok = false;
  for (let i = 1; i <= maxAttempts && !ok; i++) {
    const t0 = Date.now();
    const sampling = cfg.resample && i > 1 ? { seed: seed + i - 1, temperature: RESAMPLE_TEMPERATURE } : { seed, temperature: 0 };
    const reply = await chat(backend, port, model, cfg.resample ? messages.slice(0, 2) : messages, sampling);
    code = extractCode(reply.replace(/<think>[\s\S]*?<\/think>/g, "")); // a thinking server leaks its reasoning into content
    await writeFile(join(dir, `${ex}.ts`), code);
    const pt = await runTests(join(dir, "public.test.ts"));
    const failed = pt.lines.filter((l) => !l.ok);
    const total = Object.values(splitInfo.examples).flat().length;
    ok = pt.lines.length === total && failed.length === 0;
    const feedback = pt.lines.length === 0
      ? `The file did not load:\n${pt.stderr.split("\n").filter(Boolean).slice(-8).join("\n")}`
      : failed.map((l) => `- ${l.name}: ${l.msg}`).join("\n").slice(0, 3000);
    tries.push({ attempt: i, kind: ok ? undefined : pt.lines.length === 0 ? "compile" : "public", sampling, ms: Date.now() - t0, publicPassed: pt.lines.length - failed.length, publicTotal: total, feedback: ok ? undefined : feedback.slice(0, 600) });
    if (!ok) messages.push({ role: "assistant", content: reply }, { role: "user", content: `The file fails these examples:\n${feedback}\n\nFix it and return the complete corrected file.` });
  }
  const held = await heldOut(dataset, ex, join(dir, "heldout"), code, splitInfo);
  const fails = tries.filter((t) => t.kind);
  return { publicPass: ok, attempts: tries.length, failCounts: { compile: fails.filter((t) => t.kind === "compile").length, public: fails.filter((t) => t.kind === "public").length, constraint: 0 }, finalSource: code.slice(0, 20000), maxAttemptsPerUnit: tries.length, tries, heldOut: held, promptChars: messages[1].content.length + SYSTEM.length };
}
