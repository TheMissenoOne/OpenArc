// Model backends: one bounded interface, request in, raw `{body, imports}` JSON text out (spec §13).
// Hand-written. The ollama path goes through the model.buildRequest and model.call regions (dogfooding).
// Hosted APIs use plain fetch through HttpPort; no SDK dependencies.
import type { Json } from "openarc";
import type { Ports } from "./types.ts";
import type { BackendConfig } from "./config.ts";
import { hostOf } from "./config.ts";
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

// OpenAI strict json_schema needs every property listed in `required`; imports: [] is what parseOutput defaults to anyway.
const STRICT_OUTPUT_SCHEMA = { ...(MODEL_OUTPUT_SCHEMA as Record<string, Json>), required: ["body", "imports"] } as Json;

/** fetch() connection failures: the server is down or restarting (e.g. Ollama OOM-killed mid-run). */
const isConnectionError = (e: unknown) =>
  /ECONNREFUSED|fetch failed/.test(`${(e as Error)?.message} ${((e as Error)?.cause as { code?: string } | undefined)?.code ?? ""}`);

/** One request; on a connection error, wait `retryDelayMs` and retry ONCE (Ollama restarts after an OOM kill). */
export async function complete(ports: Ports, b: BackendConfig, system: string, user: string, env: Record<string, string | undefined> = process.env, retryDelayMs = 10_000): Promise<string> {
  try {
    return await completeOnce(ports, b, system, user, env);
  } catch (e) {
    if (!isConnectionError(e)) throw e;
    ports.log(`  backend ${b.provider} ${baseUrlOf(b)}: connection failed, retrying once in ${retryDelayMs / 1000}s`);
    await new Promise((r) => setTimeout(r, retryDelayMs));
    return completeOnce(ports, b, system, user, env);
  }
}

async function completeOnce(ports: Ports, b: BackendConfig, system: string, user: string, env: Record<string, string | undefined>): Promise<string> {
  const seed = b.seed ?? 1;
  const maxTokens = b.outputReserveTokens ?? 2048;
  if (b.provider === "ollama") {
    const cfg = { host: hostOf(b), model: b.model, seed, numCtx: b.maxContextTokens };
    const req = buildRequest(system, user, cfg, MODEL_OUTPUT_SCHEMA);
    if (b.think !== undefined) req.think = b.think;
    req.keep_alive = b.keepAlive ?? "2m";
    return call(ports.http, cfg, req);
  }
  const key = apiKey(b, env);
  try {
    if (b.provider === "openai") {
      const response_format: Json = b.structuredOutput === "json_object"
        ? { type: "json_object" }
        : { type: "json_schema", json_schema: { name: "openarc_region", strict: true, schema: STRICT_OUTPUT_SCHEMA } };
      const body: Json = {
        model: b.model,
        temperature: 0,
        seed,
        max_tokens: maxTokens,
        response_format,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };
      const headers: Record<string, string> = { ...b.headers };
      if (key) headers.authorization = `Bearer ${key}`;
      const res = JSON.parse(await ports.http.postJson(`${baseUrlOf(b)}/chat/completions`, body, headers)) as { choices?: { message?: { content?: string | null } }[] };
      const content = res.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("openai: no message content");
      return content;
    }
    // anthropic: structured outputs (output_config.format). Forced tool_choice is rejected by current models
    // (Opus 5.5, Sonnet 5.5), and API version 2026-10-21 rejects temperature/top_p/top_k, so no sampling fields.
    const body: Json = {
      model: b.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: MODEL_OUTPUT_SCHEMA } },
    };
    const headers: Record<string, string> = { ...b.headers, "x-api-key": key!, "anthropic-version": ANTHROPIC_VERSION };
    const res = JSON.parse(await ports.http.postJson(`${baseUrlOf(b)}/messages`, body, headers)) as { stop_reason?: string; content?: { type: string; text?: string }[] };
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") throw new Error(`anthropic: stop_reason ${res.stop_reason}`);
    const text = res.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") throw new Error("anthropic: no text block");
    return text;
  } catch (e) {
    // ponytail: providers sometimes echo the key in error bodies; scrub it before it reaches diagnostics or logs.
    const msg = (e as Error).message;
    throw new Error(key ? msg.split(key).join("***") : msg);
  }
}
