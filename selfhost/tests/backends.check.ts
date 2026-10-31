// Request shapes of every backend, against a fake HttpPort. No network. Run: node tests/backends.check.ts
import assert from "node:assert";
import type { Json } from "open-arc";
import type { Ports } from "../src/types.ts";
import type { BackendConfig } from "../src/config.ts";
import { parseConfig } from "../src/config.ts";
import { complete, ANTHROPIC_VERSION, OUTPUT_SCHEMA } from "../src/backends.ts";
import { MODEL_OUTPUT_SCHEMA } from "../src/model.ts";

const OUT = '{"body":"return 1;","imports":[]}';
function fake(response: string) {
  const seen: { url: string; body: Json; headers?: Record<string, string> }[] = [];
  const ports = { http: { async postJson(url: string, body: Json, headers?: Record<string, string>) { seen.push({ url, body, headers }); return response; }, async get() { throw new Error("no get"); } } } as unknown as Ports;
  return { ports, seen };
}
const env = { OPENAI_API_KEY: "sk-test-openai", OPENROUTER_API_KEY: "sk-or-test", ANTHROPIC_API_KEY: "sk-ant-test" };
const openaiReply = JSON.stringify({ choices: [{ message: { role: "assistant", content: OUT } }] });
const msgs = [{ role: "system", content: "S" }, { role: "user", content: "U" }];
// The §8.4 schema plus an optional `default` on imports items; strict mode lists it as required and nullable.
const item = (required: string[], def: Json) => ({ type: "object", required, additionalProperties: false, properties: { from: { type: "string" }, names: { type: "array", items: { type: "string" } }, default: def } });
const schemaWith = (required: string[], def: Json) => ({ ...(MODEL_OUTPUT_SCHEMA as object), properties: { body: { type: "string" }, imports: { type: "array", items: item(required, def) } } });
assert.deepStrictEqual(OUTPUT_SCHEMA, schemaWith(["from", "names"], { type: "string" }));
const strictSchema = { ...schemaWith(["from", "names", "default"], { type: ["string", "null"] }), required: ["body", "imports"] };

// openai
{
  const { ports, seen } = fake(openaiReply);
  const b: BackendConfig = { provider: "openai", model: "gpt-5", apiKeyEnv: "OPENAI_API_KEY", maxContextTokens: 32768, seed: 3 };
  assert.equal(await complete(ports, b, "S", "U", env), OUT);
  assert.deepStrictEqual(seen, [{
    url: "https://api.openai.com/v1/chat/completions",
    headers: { authorization: "Bearer sk-test-openai" },
    body: { model: "gpt-5", temperature: 0, seed: 3, max_tokens: 3072, response_format: { type: "json_schema", json_schema: { name: "openarc_region", strict: true, schema: strictSchema } }, messages: msgs },
  }]);
}
// openrouter-style: baseUrl + extra headers + json_object
{
  const { ports, seen } = fake(openaiReply);
  const b: BackendConfig = {
    provider: "openai", model: "qwen/qwen3-coder", baseUrl: "https://openrouter.ai/api/v1/", apiKeyEnv: "OPENROUTER_API_KEY",
    headers: { "HTTP-Referer": "https://example.dev", "X-Title": "OpenArc" }, structuredOutput: "json_object", maxContextTokens: 32768, outputReserveTokens: 4096,
  };
  assert.equal(await complete(ports, b, "S", "U", env), OUT);
  assert.deepStrictEqual(seen, [{
    url: "https://openrouter.ai/api/v1/chat/completions",
    headers: { "HTTP-Referer": "https://example.dev", "X-Title": "OpenArc", authorization: "Bearer sk-or-test" },
    body: { model: "qwen/qwen3-coder", temperature: 0, seed: 1, max_tokens: 4096, response_format: { type: "json_object" }, messages: msgs },
  }]);
}
// openai-compatible local server without a key: no authorization header
{
  const { ports, seen } = fake(openaiReply);
  await complete(ports, { provider: "openai", model: "local", baseUrl: "http://127.0.0.1:1234/v1", maxContextTokens: 8192 }, "S", "U", env);
  assert.deepStrictEqual(seen[0]!.headers, {});
}
// anthropic
{
  const reply = JSON.stringify({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: OUT }] });
  const { ports, seen } = fake(reply);
  const b: BackendConfig = { provider: "anthropic", model: "claude-opus-5-5", apiKeyEnv: "ANTHROPIC_API_KEY", maxContextTokens: 64000, outputReserveTokens: 16000 };
  assert.equal(await complete(ports, b, "S", "U", env), OUT);
  assert.deepStrictEqual(seen, [{
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": "sk-ant-test", "anthropic-version": ANTHROPIC_VERSION },
    body: { model: "claude-opus-5-5", max_tokens: 16000, system: "S", messages: [{ role: "user", content: "U" }], output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } } },
  }]);
  const refused = fake(JSON.stringify({ stop_reason: "refusal", content: [] }));
  await assert.rejects(complete(refused.ports, b, "S", "U", env), /stop_reason refusal/);
}
// ollama goes through model.buildRequest + model.call, with keep_alive
{
  const { ports, seen } = fake(JSON.stringify({ message: { role: "assistant", content: OUT }, done: true }));
  assert.equal(await complete(ports, { provider: "ollama", model: "qwen3.5:9b", maxContextTokens: 8192, think: false }, "S", "U", env), OUT);
  assert.equal(seen[0]!.url, "http://127.0.0.1:11434/api/chat");
  assert.equal((seen[0]!.body as { model: string }).model, "qwen3.5:9b");
  assert.deepStrictEqual((seen[0]!.body as { options: Json }).options, { temperature: 0, seed: 1, num_ctx: 8192, num_predict: 3072 }, "output cap = outputReserveTokens (default 3072)");
  assert.deepStrictEqual((seen[0]!.body as { format: Json }).format, OUTPUT_SCHEMA);
  // a varied retry (engine.retrySampling) reaches the request
  await complete(ports, { provider: "ollama", model: "m", maxContextTokens: 4096, outputReserveTokens: 1000, seed: 5, temperature: 0.4 }, "S", "U", env);
  assert.deepStrictEqual((seen[1]!.body as { options: Json }).options, { temperature: 0.4, seed: 5, num_ctx: 4096, num_predict: 1000 });
}
// missing key: OARC-E080 detail token, never the key
{
  const { ports, seen } = fake(openaiReply);
  await assert.rejects(complete(ports, { provider: "anthropic", model: "m", apiKeyEnv: "NOPE_KEY", maxContextTokens: 8192 }, "S", "U", env), { message: "missing-key:NOPE_KEY" });
  assert.equal(seen.length, 0);
}
// a key echoed in a provider error is scrubbed
{
  const ports = { http: { async postJson() { throw new Error("HTTP 401: bad key sk-test-openai"); } } } as unknown as Ports;
  await assert.rejects(complete(ports, { provider: "openai", model: "m", apiKeyEnv: "OPENAI_API_KEY", maxContextTokens: 8192 }, "S", "U", env), { message: "HTTP 401: bad key ***" });
}
// config: literal keys rejected
{
  const cfg = (b: object) => parseConfig(JSON.stringify({ version: 1, backends: { x: b } })).error;
  assert.match(cfg({ provider: "openai", model: "m", maxContextTokens: 1, apiKey: "sk-..." })!, /literal "apiKey" is not allowed/);
  assert.match(cfg({ provider: "anthropic", model: "m", maxContextTokens: 1 })!, /apiKeyEnv/);
  assert.match(cfg({ provider: "gemini", model: "m", maxContextTokens: 1 })!, /unknown provider/);
  assert.equal(cfg({ provider: "openai", model: "m", maxContextTokens: 1, apiKeyEnv: "K" }), undefined);
}
// connection error (Ollama died mid-run): retried exactly once, then given up
{
  const ollama: BackendConfig = { provider: "ollama", model: "m", maxContextTokens: 8192 };
  const reply = JSON.stringify({ message: { role: "assistant", content: OUT }, done: true });
  const flaky = (failures: Error[]) => {
    let calls = 0;
    const logs: string[] = [];
    const ports = { log: (l: string) => logs.push(l), http: { async postJson() { calls++; const e = failures.shift(); if (e) throw e; return reply; } } } as unknown as Ports;
    return { ports, logs, calls: () => calls };
  };
  const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const once = flaky([refused()]);
  assert.equal(await complete(once.ports, ollama, "S", "U", env, 0), OUT);
  assert.equal(once.calls(), 2);
  assert.match(once.logs[0]!, /retrying once/);
  const twice = flaky([refused(), refused()]);
  await assert.rejects(complete(twice.ports, ollama, "S", "U", env, 0), /fetch failed/);
  assert.equal(twice.calls(), 2);
  const other = flaky([new Error("HTTP 500: boom")]);
  await assert.rejects(complete(other.ports, ollama, "S", "U", env, 0), /HTTP 500/);
  assert.equal(other.calls(), 1, "only connection errors are retried");
  const body = flaky([new Error("HTTP 502: upstream said fetch failed, ECONNREFUSED")]);
  await assert.rejects(complete(body.ports, ollama, "S", "U", env, 0), /HTTP 502/);
  assert.equal(body.calls(), 1, "a response body that mentions a connection error is not retried");
  const hosted = flaky([Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1234"), { code: "ECONNREFUSED" })]);
  assert.equal(await complete(hosted.ports, { provider: "openai", model: "local", baseUrl: "http://127.0.0.1:1234/v1", maxContextTokens: 8192 }, "S", "U", env, 0).catch((e) => e.message), "openai: no message content");
  assert.equal(hosted.calls(), 2);
}
// truncated output (cut at the output cap): retried with double the cap, up to the context window minus the prompt
{
  const replies = (rs: string[]) => {
    const caps: Json[] = [];
    const logs: string[] = [];
    const ports = { log: (l: string) => logs.push(l), http: { async postJson(_u: string, body: Json) { caps.push(body); return rs.shift()!; } } } as unknown as Ports;
    return { ports, caps, logs };
  };
  const cut = JSON.stringify({ message: { role: "assistant", content: '{"body":"retur' }, done: true, done_reason: "length" });
  const whole = JSON.stringify({ message: { role: "assistant", content: OUT }, done: true, done_reason: "stop" });
  const o = replies([cut, cut, whole]);
  assert.equal(await complete(o.ports, { provider: "ollama", model: "m", maxContextTokens: 16384 }, "S", "U", env), OUT);
  assert.deepStrictEqual(o.caps.map((b) => (b as { options: { num_predict: number } }).options.num_predict), [3072, 6144, 12288]);
  assert.match(o.logs[0]!, /output truncated at 3072 tokens, retrying with 6144/);
  // capped by the context window minus the prompt (8192 - ceil(7000/3.5) = 6192), then given up with the cut text
  const big = "x".repeat(7000);
  const c = replies([cut, cut, cut]);
  assert.equal(await complete(c.ports, { provider: "ollama", model: "m", maxContextTokens: 8192 }, "S", big.slice(1), env), '{"body":"retur');
  assert.deepStrictEqual(c.caps.map((b) => (b as { options: { num_predict: number } }).options.num_predict), [3072, 6144, 6192]);
  assert.match(c.logs[2]!, /no room left/);
  // openai finish_reason, anthropic stop_reason
  const oa = replies([JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"bo' } }] }), openaiReply]);
  assert.equal(await complete(oa.ports, { provider: "openai", model: "m", maxContextTokens: 32768, outputReserveTokens: 1000 }, "S", "U", env), OUT);
  assert.deepStrictEqual(oa.caps.map((b) => (b as { max_tokens: number }).max_tokens), [1000, 2000]);
  const an = replies([JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "" }] }), JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: OUT }] })]);
  assert.equal(await complete(an.ports, { provider: "anthropic", model: "m", apiKeyEnv: "ANTHROPIC_API_KEY", maxContextTokens: 64000, outputReserveTokens: 16000 }, "S", "U", env), OUT);
  assert.deepStrictEqual(an.caps.map((b) => (b as { max_tokens: number }).max_tokens), [16000, 32000]);
}
// openai provider pointed at Ollama's /v1: keep_alive and reasoning_effort "none" (auto-detected or ollamaCompat)
{
  const { ports, seen } = fake(openaiReply);
  await complete(ports, { provider: "openai", model: "qwen3.5:9b", baseUrl: "http://127.0.0.1:11434/v1", maxContextTokens: 8192, structuredOutput: "json_object" }, "S", "U", env);
  await complete(ports, { provider: "openai", model: "q", baseUrl: "http://gpu-box:8080/v1", ollamaCompat: true, keepAlive: "10m", maxContextTokens: 8192 }, "S", "U", env);
  await complete(ports, { provider: "openai", model: "q", baseUrl: "http://gpu-box:8080/v1", maxContextTokens: 8192 }, "S", "U", env);
  const extra = (b: Json) => ({ keep_alive: (b as { keep_alive?: string }).keep_alive, reasoning_effort: (b as { reasoning_effort?: string }).reasoning_effort });
  assert.deepStrictEqual(seen.map((q) => extra(q.body)), [{ keep_alive: "2m", reasoning_effort: "none" }, { keep_alive: "10m", reasoning_effort: "none" }, { keep_alive: undefined, reasoning_effort: undefined }]);
}
console.log("backends: request shapes, truncation retry, ollama /v1 ok");
