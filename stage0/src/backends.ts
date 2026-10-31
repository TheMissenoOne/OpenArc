// Model backends: one bounded interface, request in, raw `{body, imports}` JSON text out (spec §13).
// Hand-written. The ollama path goes through the model.buildRequest and model.call regions (dogfooding).
// Hosted APIs use plain fetch through HttpPort; no SDK dependencies.
import type { Json } from "open-arc";
import type { HttpPort, Ports } from "./types.ts";
import type { BackendConfig } from "./config.ts";
import { DEFAULT_OUTPUT_RESERVE, hostOf } from "./config.ts";
import { MODEL_OUTPUT_SCHEMA, buildRequest, call } from "./model.ts";

export const ANTHROPIC_VERSION = "2026-10-21";

/** Base URL of a backend, without a trailing slash. */
export const baseUrlOf = (b: BackendConfig): string =>
  b.provider === "ollama" ? hostOf(b) : (b.baseUrl ?? (b.provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")).replace(/\/$/, "");

/** Throws Error("missing-key:<ENV>") when the named env var is unset. The key itself never appears in a message. */
function apiKey(b: BackendConfig, env: Record<string, string | undefined>): string | null {
  if (!b.apiKeyEnv) return null;
  const key = env[b.apiKeyEnv];
  if (!key) throw new Error(`missing-key:${b.apiKeyEnv}`);
  return key;
}

type Schema = { [k: string]: Json };
const importItem = ((MODEL_OUTPUT_SCHEMA as Schema).properties as Schema).imports as Schema;
const withImportItem = (required: string[], defaultType: Json, extra: Schema = {}): Json => ({
  ...(MODEL_OUTPUT_SCHEMA as Schema),
  ...extra,
  properties: {
    ...((MODEL_OUTPUT_SCHEMA as Schema).properties as Schema),
    imports: { ...importItem, items: { ...(importItem.items as Schema), required, properties: { ...((importItem.items as Schema).properties as Schema), default: defaultType } } },
  },
});
/** The §8.4 schema plus an optional `default` (a default import's local name) on each imports item. */
export const OUTPUT_SCHEMA: Json = withImportItem(["from", "names"], { type: "string" });
// OpenAI strict json_schema needs every property listed in `required` (imports: [] and default: null mean absent).
const STRICT_OUTPUT_SCHEMA: Json = withImportItem(["from", "names", "default"], { type: ["string", "null"] }, { required: ["body", "imports"] });

/** fetch() connection failures: the server is down or restarting (e.g. Ollama OOM-killed mid-run). Judged by the
 *  error code only (fetch puts it on `cause`), never the message: an HTTP error message carries the response body. */
const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const isConnectionError = (e: unknown) => {
  const x = e as { code?: unknown; cause?: { code?: unknown } } | null;
  return CONNECTION_CODES.has(String(x?.code)) || CONNECTION_CODES.has(String(x?.cause?.code));
};

/** One completion. The output cap is bounded by the context room left after the prompt (~3.5 chars/token). A reply
 *  cut at the cap (Ollama done_reason "length", OpenAI finish_reason "length", Anthropic stop_reason "max_tokens") is
 *  retried with double the cap, up to that room; if the retry fails, the truncated reply is returned (parse/repair then
 *  handles it like any other reply) rather than lost. */
export async function complete(ports: Ports, b: BackendConfig, system: string, user: string, env: Record<string, string | undefined> = process.env, retryDelayMs = 10_000): Promise<string> {
  const room = b.maxContextTokens - Math.ceil((system.length + user.length) / 3.5);
  // ponytail: never below MIN_OUTPUT, even when the estimate says the prompt alone fills the window (the estimate is rough).
  let cur: BackendConfig = { ...b, outputReserveTokens: Math.min(b.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE, Math.max(room, MIN_OUTPUT)) };
  let r = await withReconnect(ports, cur, system, user, env, retryDelayMs);
  while (r.truncated) {
    const cap = cur.outputReserveTokens!;
    const next = Math.min(cap * 2, room);
    if (next <= cap) {
      ports.log(`  backend ${b.provider} ${b.model}: output truncated at ${cap} tokens; no room left in the ${b.maxContextTokens}-token context`);
      return r.text;
    }
    ports.log(`  backend ${b.provider} ${b.model}: output truncated at ${cap} tokens, retrying with ${next}`);
    cur = { ...cur, outputReserveTokens: next };
    try {
      r = await withReconnect(ports, cur, system, user, env, retryDelayMs);
    } catch (e) {
      ports.log(`  backend ${b.provider} ${b.model}: retry with ${next} tokens failed (${String((e as Error).message ?? e).slice(0, 160)}); using the reply truncated at ${cap}`);
      return r.text;
    }
  }
  return r.text;
}
const MIN_OUTPUT = 256;

/** One request; on a connection error, wait `retryDelayMs` and retry ONCE (Ollama restarts after an OOM kill). */
async function withReconnect(ports: Ports, b: BackendConfig, system: string, user: string, env: Record<string, string | undefined>, retryDelayMs: number): Promise<Reply> {
  try {
    return await completeOnce(ports, b, system, user, env);
  } catch (e) {
    if (!isConnectionError(e)) throw e;
    ports.log(`  backend ${b.provider} ${baseUrlOf(b)}: connection failed, retrying once in ${retryDelayMs / 1000}s`);
    await new Promise((r) => setTimeout(r, retryDelayMs));
    return completeOnce(ports, b, system, user, env);
  }
}

type Reply = { text: string; truncated: boolean };

/** Ollama's OpenAI-compatible /v1 (explicit `ollamaCompat`, else a baseUrl on port 11434 ending in /v1). */
export const isOllamaCompat = (b: BackendConfig): boolean => b.ollamaCompat ?? /:11434\/v1$/.test(baseUrlOf(b));

async function completeOnce(ports: Ports, b: BackendConfig, system: string, user: string, env: Record<string, string | undefined>): Promise<Reply> {
  const seed = b.seed ?? 1;
  const temperature = b.temperature ?? 0;
  const maxTokens = b.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE;
  if (b.provider === "ollama") {
    const cfg = { host: hostOf(b), model: b.model, seed, numCtx: b.maxContextTokens };
    const req = buildRequest(system, user, cfg, OUTPUT_SCHEMA);
    // The output cap: without num_predict a confused model can generate for minutes and still return truncated JSON.
    req.options = { ...req.options, temperature, num_predict: maxTokens };
    if (b.think !== undefined) req.think = b.think;
    req.keep_alive = b.keepAlive ?? "2m";
    // model.call (a region) returns only message.content: keep the raw reply to read done_reason.
    let raw = "";
    const http: HttpPort = { ...ports.http, postJson: async (url, body, headers) => (raw = await ports.http.postJson(url, body, headers)) };
    const text = await call(http, cfg, req);
    return { text, truncated: (JSON.parse(raw) as { done_reason?: string }).done_reason === "length" };
  }
  const key = apiKey(b, env);
  try {
    if (b.provider === "openai") {
      const response_format: Json = b.structuredOutput === "json_object"
        ? { type: "json_object" }
        : { type: "json_schema", json_schema: { name: "openarc_region", strict: true, schema: STRICT_OUTPUT_SCHEMA } };
      const body: Json = {
        model: b.model,
        temperature,
        seed,
        max_tokens: maxTokens,
        response_format,
        // Ollama's /v1 ignores keep-alive config and may think: pass both explicitly (unknown fields are ignored there).
        ...(isOllamaCompat(b) ? { keep_alive: b.keepAlive ?? "2m", reasoning_effort: "none" } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };
      const headers: Record<string, string> = { ...b.headers };
      if (key) headers.authorization = `Bearer ${key}`;
      const res = JSON.parse(await ports.http.postJson(`${baseUrlOf(b)}/chat/completions`, body, headers)) as { choices?: { finish_reason?: string; message?: { content?: string | null } }[] };
      const content = res.choices?.[0]?.message?.content;
      const truncated = res.choices?.[0]?.finish_reason === "length";
      if (typeof content !== "string") {
        if (truncated) return { text: "", truncated };
        throw new Error("openai: no message content");
      }
      return { text: content, truncated };
    }
    // anthropic: structured outputs (output_config.format). Forced tool_choice is rejected by current models
    // (Opus 5.5, Sonnet 5.5), and API version 2026-10-21 rejects temperature/top_p/top_k, so no sampling fields.
    // ponytail: so the identical-prompt retry variation (temperature/seed) doesn't reach this provider; the repair text does.
    const body: Json = {
      model: b.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    };
    const headers: Record<string, string> = { ...b.headers, "x-api-key": key!, "anthropic-version": ANTHROPIC_VERSION };
    const res = JSON.parse(await ports.http.postJson(`${baseUrlOf(b)}/messages`, body, headers)) as { stop_reason?: string; content?: { type: string; text?: string }[] };
    if (res.stop_reason === "refusal") throw new Error(`anthropic: stop_reason ${res.stop_reason}`);
    const truncated = res.stop_reason === "max_tokens"; // thinking counts against max_tokens: a truncated reply may have no text yet
    const text = res.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") {
      if (truncated) return { text: "", truncated };
      throw new Error("anthropic: no text block");
    }
    return { text, truncated };
  } catch (e) {
    // ponytail: providers sometimes echo the key in error bodies; scrub it before it reaches diagnostics or logs.
    const msg = (e as Error).message;
    const x = e as { code?: unknown; cause?: { code?: unknown } };
    throw Object.assign(new Error(key ? msg.split(key).join("***") : msg), { code: x.code ?? x.cause?.code }); // the code drives the retry
  }
}

/** `openarc backends test`: ONE tiny structured request through the real backend path (complete), so it exercises the
 *  same URL, headers, key and response_format a compile uses. Ollama: also checks the model is pulled. Never prints a key. */
export async function testBackend(ports: Ports, b: BackendConfig, env: Record<string, string | undefined> = process.env, timeoutMs = 120_000): Promise<{ ok: boolean; ms: number; detail: string }> {
  const t0 = Date.now();
  const done = (ok: boolean, detail: string) => ({ ok, ms: Date.now() - t0, detail });
  if (b.apiKeyEnv && !env[b.apiKeyEnv]) return done(false, `missing key: env ${b.apiKeyEnv} is not set`);
  if (b.provider === "ollama") {
    let tags: { models?: { name: string }[] };
    try {
      tags = JSON.parse(await ports.http.get(`${hostOf(b)}/api/tags`)) as typeof tags;
    } catch {
      return done(false, `unreachable: ${hostOf(b)}/api/tags`);
    }
    if (!(tags.models ?? []).some((m) => m.name === b.model || m.name === `${b.model}:latest`)) return done(false, `model not pulled: run \`ollama pull ${b.model}\``);
  }
  const system = "You are a connection test. Reply with JSON only.";
  const user = 'Return exactly this JSON object: {"body": "return 1;", "imports": []}';
  let text: string;
  try {
    // ponytail: a small cap and no reconnect pause; the timeout covers a server that accepts and never answers
    const call = complete({ ...ports, log: () => {} }, { ...b, outputReserveTokens: 256 }, system, user, env, 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs)));
    text = await Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  } catch (e) {
    return done(false, explainFailure(e, b));
  }
  try {
    const out = JSON.parse(text) as { body?: unknown };
    if (typeof out?.body !== "string") return done(false, `invalid reply: no "body" string in ${JSON.stringify(text.slice(0, 80))}`);
    return done(true, `replied ${JSON.stringify(out.body.slice(0, 40))}`);
  } catch {
    return done(false, `invalid JSON in the reply (the model or endpoint may ignore structured output): ${JSON.stringify(text.slice(0, 80))}`);
  }
}

/** A short reason for a failed test request, with what to change. */
export function explainFailure(e: unknown, b: BackendConfig): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith("missing-key:")) return `missing key: env ${msg.slice(12)} is not set`;
  if (isConnectionError(e)) return `unreachable: ${baseUrlOf(b)}`;
  if (/^HTTP (401|403)\b/.test(msg)) return `auth rejected (${msg.slice(0, 8)}): check the key in env ${b.apiKeyEnv ?? "(none configured: set apiKeyEnv)"}`;
  if (b.provider === "openai" && b.structuredOutput !== "json_object" && /^HTTP 4\d\d\b/.test(msg) && /json_schema|response_format|structured/i.test(msg))
    return `json_schema unsupported by this endpoint or model (${msg.slice(0, 120)}): set "structuredOutput": "json_object" on this backend`;
  if (/^HTTP 404\b/.test(msg) || /model.{0,40}(not found|does not exist|not available)|no such model|unknown model/i.test(msg)) return `model not found: check "model" (${b.model}) and "baseUrl" (${msg.slice(0, 120)})`;
  return msg.slice(0, 200);
}

/** One line of `openarc backends`: provider (and preset), model, URL, and whether the key's env var is set. */
export function describeBackend(name: string, b: BackendConfig, isDefault: boolean, env: Record<string, string | undefined> = process.env): string {
  const provider = b.preset && b.preset !== b.provider ? `${b.provider} (${b.preset})` : b.provider;
  const key = b.apiKeyEnv ? `key ${b.apiKeyEnv} ${env[b.apiKeyEnv] ? "set" : "NOT set"}` : "no key";
  return `${isDefault ? "*" : " "} ${name}  ${provider}  ${b.model}  ${baseUrlOf(b)}  ${key}`;
}
