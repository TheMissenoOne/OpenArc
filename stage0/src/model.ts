import * as arc from "open-arc";
import type { Json } from "open-arc";
import type { HttpPort, ModelConfig, ModelOutput, OllamaChatRequest, Rendered } from "./types.ts";
import type { ImportDecl } from "./types.ts";

// Policy artifacts: hand-written, versioned and part of the fingerprint (§4.3).
// They are deliberately NOT regions. A generated prompt template would make the cache key depend on a model's output.
export const PROMPT_TEMPLATE_VERSION = "5";
/** {{context}} is the deterministic context package (engine.buildContext); {{repair}} is empty on attempt 1. */
export const PROMPT_TEMPLATE = `Implement exactly one OpenArc region in TypeScript.

{{context}}

{{repair}}

Reply with JSON only: {"body": "<statements>", "imports": []}. Add {"from": "<specifier>", "names": ["<name>"]} to "imports" only for a new import the Rules allow.`;
/** Several independent regions of one file in one request (compilation.batch "file"): {{context}} is
 *  engine.batchContext (shared sections once, then one "## Region <id>" section each), {{shape}} the reply object. */
export const BATCH_PROMPT_TEMPLATE = `Implement {{count}} OpenArc regions of one file in TypeScript. They are independent: each body is its own function, and nothing one body declares is visible in another, so write each one complete on its own.

{{context}}

Reply with JSON only, one entry per region id: {{shape}}. Add {"from": "<specifier>", "names": ["<name>"]} to a region's "imports" only for a new import the Rules allow.`;
export const MODEL_OUTPUT_SCHEMA: Json = {
  type: "object",
  required: ["body"],
  additionalProperties: false,
  properties: {
    body: { type: "string" },
    imports: {
      type: "array",
      items: {
        type: "object",
        required: ["from", "names"],
        additionalProperties: false,
        properties: { from: { type: "string" }, names: { type: "array", items: { type: "string" } } },
      },
    },
  },
};

// ── model.renderTemplate ──────────────────────────────────────── spec §8.4
type RenderTemplate = (template: string, vars: Record<string, string>) => Rendered;

export const renderTemplateSpec = arc.defineRegion<RenderTemplate>({
  id: "model.renderTemplate",
  intent: "Replace every {{name}} (name = [a-zA-Z0-9_]+) with vars[name], one pass, no recursion. If any name is missing, return ok:false with missing names, deduplicated, in first-occurrence order.",
  examples: [
    { args: ["Hello {{name}}", { name: "x" }], expected: { ok: true, text: "Hello x" } },
    { args: ["{{a}}{{a}}", { a: "1" }], expected: { ok: true, text: "11" } },
    { name: "no recursion", args: ["{{a}}", { a: "{{b}}", b: "!" }], expected: { ok: true, text: "{{b}}" } },
    { args: ["{{a}} {{b}} {{a}}", {}], expected: { ok: false, missing: ["a", "b"] } },
  ],
});

// @openarc:begin model.renderTemplate
export const renderTemplate: RenderTemplate = (template, vars) => {
  const missing: string[] = [];
  const text = template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name]!;
    if (!missing.includes(name)) missing.push(name);
    return "";
  });
  return missing.length ? { ok: false, missing } : { ok: true, text };
};
// @openarc:end model.renderTemplate

// ── model.buildRequest ────────────────────────────────────────── spec §8.4
type BuildRequest = (system: string, user: string, cfg: ModelConfig, format: Json) => OllamaChatRequest;

export const buildRequestSpec = arc.defineRegion<BuildRequest>({
  id: "model.buildRequest",
  intent: "Build an Ollama /api/chat body: stream false, temperature 0, seed and num_ctx from cfg, system message then user message.",
  examples: [
    {
      args: ["S", "U", { host: "http://127.0.0.1:11434", model: "qwen2.5-coder:14b", seed: 7, numCtx: 8192 }, { type: "object" }],
      expected: {
        model: "qwen2.5-coder:14b",
        stream: false,
        format: { type: "object" },
        options: { temperature: 0, seed: 7, num_ctx: 8192 },
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
      },
    },
  ],
});

// @openarc:begin model.buildRequest
export const buildRequest: BuildRequest = (system, user, cfg, format) => ({
  model: cfg.model,
  stream: false,
  format,
  options: { temperature: 0, seed: cfg.seed, num_ctx: cfg.numCtx },
  messages: [
    { role: "system", content: system },
    { role: "user", content: user },
  ],
});
// @openarc:end model.buildRequest

// ── model.parseOutput ─────────────────────────────────────────── spec §8.4, OARC-E081
type ParseOutput = (raw: string) => ModelOutput;

export const parseOutputSpec = arc.defineRegion<ParseOutput>({
  id: "model.parseOutput",
  intent: [
    "Parse raw (the assistant message content) as JSON and validate it against MODEL_OUTPUT_SCHEMA by hand (no schema library).",
    "On failure return OARC-E081 with the FIRST problem as detail: invalid-json | not-object | body-not-string | unexpected-property:<key> | bad-imports.",
    "imports defaults to [].",
  ],
  examples: [
    { args: ["{\"body\":\"return 1;\"}"], expected: { ok: true, body: "return 1;", imports: [] } },
    {
      args: ["{\"body\":\"x\",\"imports\":[{\"from\":\"./a.ts\",\"names\":[\"f\"]}]}"],
      expected: { ok: true, body: "x", imports: [{ from: "./a.ts", names: ["f"] }] },
    },
    { args: ["not json"], expected: { ok: false, diagnostic: { code: "OARC-E081", detail: "invalid-json" } } },
    { args: ["[1]"], expected: { ok: false, diagnostic: { code: "OARC-E081", detail: "not-object" } } },
    { args: ["{\"body\":1}"], expected: { ok: false, diagnostic: { code: "OARC-E081", detail: "body-not-string" } } },
    {
      args: ["{\"body\":\"x\",\"extra\":true}"],
      expected: { ok: false, diagnostic: { code: "OARC-E081", detail: "unexpected-property:extra" } },
    },
    {
      args: ["{\"body\":\"x\",\"imports\":[{\"from\":\"a\"}]}"],
      expected: { ok: false, diagnostic: { code: "OARC-E081", detail: "bad-imports" } },
    },
  ],
});

// @openarc:begin model.parseOutput
export const parseOutput: ParseOutput = (raw) => {
  const bad = (detail: string): ModelOutput => ({ ok: false, diagnostic: { code: "OARC-E081", detail } });
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad("invalid-json");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad("not-object");
  const o = v as Record<string, unknown>;
  if (typeof o.body !== "string") return bad("body-not-string");
  for (const k of Object.keys(o)) if (k !== "body" && k !== "imports") return bad(`unexpected-property:${k}`);
  const imports = o.imports ?? [];
  const okImport = (i: unknown) => {
    if (typeof i !== "object" || i === null || Array.isArray(i)) return false;
    const r = i as Record<string, unknown>;
    return typeof r.from === "string" && Array.isArray(r.names) && r.names.every((n) => typeof n === "string") &&
      Object.keys(r).every((k) => k === "from" || k === "names");
  };
  if (!Array.isArray(imports) || !imports.every(okImport)) return bad("bad-imports");
  return { ok: true, body: o.body, imports: imports as ImportDecl[] };
};
// @openarc:end model.parseOutput

// ── model.call ────────────────────────────────────────────────── spec §8.4, OARC-E080
// Effectful: the HTTP port comes in as a fake (spec §9.4, F6).
type Call = (http: HttpPort, cfg: ModelConfig, req: OllamaChatRequest) => Promise<string>;

export const callSpec = arc.defineRegion<Call>({
  id: "model.call",
  intent: "POST req to cfg.host + '/api/chat' via http.postJson, parse the response JSON, return message.content. Do not retry; the caller owns retries.",
  examples: [
    {
      args: [
        { $fake: "http.stub", init: { responses: ['{"model":"m","message":{"role":"assistant","content":"{\\"body\\":\\"x\\"}"},"done":true}'] } },
        { host: "http://h:1", model: "m", seed: 1, numCtx: 2048 },
        { model: "m", stream: false, format: { type: "object" }, options: { temperature: 0, seed: 1, num_ctx: 2048 }, messages: [{ role: "user", content: "U" }] },
      ],
      expected: '{"body":"x"}',
      fakesAfter: {
        "http.stub": {
          requests: [{
            url: "http://h:1/api/chat",
            body: { model: "m", stream: false, format: { type: "object" }, options: { temperature: 0, seed: 1, num_ctx: 2048 }, messages: [{ role: "user", content: "U" }] },
          }],
        },
      },
    },
  ],
});

// @openarc:begin model.call
export const call: Call = async (http, cfg, req) => {
  const raw = await http.postJson(`${cfg.host}/api/chat`, req as unknown as Json);
  const r = JSON.parse(raw) as { message?: { content?: unknown }; error?: string };
  if (typeof r.message?.content !== "string") throw new Error(`ollama: ${r.error ?? "response has no message content"}`);
  return r.message.content;
};
// @openarc:end model.call
