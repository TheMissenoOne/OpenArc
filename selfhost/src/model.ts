import * as arc from "@openarc/core";
import type { Json } from "@openarc/core";
import type { HttpPort, ModelConfig, ModelOutput, OllamaChatRequest, Rendered } from "./types.ts";

// Policy artifacts: hand-written, versioned and part of the fingerprint (§4.3).
// They are deliberately NOT regions. A generated prompt template would make the cache key depend on a model's output.
export const PROMPT_TEMPLATE_VERSION = "2";
/** {{context}} is the deterministic context package (engine.buildContext); {{repair}} is empty on attempt 1. */
export const PROMPT_TEMPLATE = `Implement exactly one OpenArc region in TypeScript.

{{context}}

{{repair}}

Reply with JSON only: {"body": "<statements>", "imports": [{"from": "<specifier>", "names": ["<name>"]}]}.
Use "imports": [] unless you need something listed under "Allowed new imports" that the file doesn't already import.`;
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
export const renderTemplate: RenderTemplate = (template, vars) => arc.todo("model.renderTemplate");
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
export const buildRequest: BuildRequest = (system, user, cfg, format) => {
  return { model: cfg.model, stream: false, format, options: { temperature: 0, seed: cfg.seed, num_ctx: cfg.numCtx }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
};
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
export const parseOutput: ParseOutput = (raw) => arc.todo("model.parseOutput");
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
  const url = `${cfg.host}/api/chat`;
  const body: Json = {
    model: req.model,
    stream: req.stream,
    format: req.format,
    options: req.options,
    messages: req.messages
  };
  const response = await http.postJson(url, body);
  return JSON.parse(response).message.content;
};
// @openarc:end model.call
