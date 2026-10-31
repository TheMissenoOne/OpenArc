// Request shapes of every backend, against a fake HttpPort. No network. Run: node tests/backends.check.ts
import assert from "node:assert";
import type { Json } from "openarc";
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
    body: { model: "gpt-5", temperature: 0, seed: 3, max_tokens: 2048, response_format: { type: "json_schema", json_schema: { name: "openarc_region", strict: true, schema: strictSchema } }, messages: msgs },
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
  assert.deepStrictEqual((seen[0]!.body as { options: Json }).options, { temperature: 0, seed: 1, num_ctx: 8192, num_predict: 2048 }, "output cap = outputReserveTokens");
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
  const hosted = flaky([new Error("connect ECONNREFUSED 127.0.0.1:1234")]);
  assert.equal(await complete(hosted.ports, { provider: "openai", model: "local", baseUrl: "http://127.0.0.1:1234/v1", maxContextTokens: 8192 }, "S", "U", env, 0).catch((e) => e.message), "openai: no message content");
  assert.equal(hosted.calls(), 2);
}
console.log("backends: request shapes ok");
