// Request shapes of every backend, against a fake HttpPort. No network. Run: node tests/backends.check.ts
import assert from "node:assert";
import type { Json } from "openarc";
import type { Ports } from "../src/types.ts";
import type { BackendConfig } from "../src/config.ts";
import { parseConfig } from "../src/config.ts";
import { complete, ANTHROPIC_VERSION } from "../src/backends.ts";
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
const strictSchema = { ...(MODEL_OUTPUT_SCHEMA as object), required: ["body", "imports"] };

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
    body: { model: "claude-opus-5-5", max_tokens: 16000, system: "S", messages: [{ role: "user", content: "U" }], output_config: { format: { type: "json_schema", schema: MODEL_OUTPUT_SCHEMA } } },
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
console.log("backends: request shapes ok");
