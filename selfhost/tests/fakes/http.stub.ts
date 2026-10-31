// Authoritative fake. init: { responses: string[] }, returned in order; throws when exhausted.
// snapshot(): { requests: [{ url, body }] }. postJson headers are accepted but never recorded: they carry API keys.
import { defineFake, type Json } from "@openarc/core";
import type { HttpPort } from "../../src/types.ts";

export function stubHttp(init: Json | undefined) {
  const responses = [...((init as { responses?: string[] } | undefined)?.responses ?? [])];
  const requests: { url: string; body: Json }[] = [];
  const http: HttpPort = {
    async postJson(url, body, _headers) {
      requests.push({ url, body });
      const r = responses.shift();
      if (r === undefined) throw new Error("http.stub: no response left");
      return r;
    },
    async get(url) {
      requests.push({ url, body: null });
      const r = responses.shift();
      if (r === undefined) throw new Error("http.stub: no response left");
      return r;
    },
  };
  return { http, requests };
}

export default defineFake<HttpPort>((init) => {
  const { http, requests } = stubHttp(init);
  return { instance: http, snapshot: () => ({ requests }) };
});
