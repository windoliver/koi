import { describe, expect, test } from "bun:test";
import type { WhatsAppConfig } from "./config.js";
import { type FetchFn, sendWhatsAppMessage } from "./platform-send.js";

const config: WhatsAppConfig = {
  phoneNumberId: "pn-1",
  accessToken: "tok",
  verifyToken: "vt",
  appSecret: "as",
  graphBaseUrl: "https://graph.facebook.com/v18.0",
  production: false,
  handlerTimeoutMs: 1_000,
  commitTtlMs: 86_400_000,
};

describe("sendWhatsAppMessage", () => {
  test("200 with messages[0].id parses wamid", async () => {
    const fetchFn: FetchFn = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://graph.facebook.com/v18.0/pn-1/messages");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer tok");
      return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 });
    };
    const r = await sendWhatsAppMessage(fetchFn, config, { hello: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.wamid).toBe("wamid.OUT");
  });

  test("401 surfaces INVALID_TOKEN", async () => {
    const fetchFn: FetchFn = async () => new Response("nope", { status: 401 });
    const r = await sendWhatsAppMessage(fetchFn, config, {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("INVALID_TOKEN");
    expect(r.error.context.status).toBe(401);
  });

  test("429 surfaces RATE_LIMITED", async () => {
    const fetchFn: FetchFn = async () => new Response("slow down", { status: 429 });
    const r = await sendWhatsAppMessage(fetchFn, config, {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("RATE_LIMITED");
  });

  test("500 surfaces SEND_FAILED", async () => {
    const fetchFn: FetchFn = async () => new Response("oops", { status: 500 });
    const r = await sendWhatsAppMessage(fetchFn, config, {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("SEND_FAILED");
    expect(r.error.context.status).toBe(500);
  });

  test("network error surfaces SEND_FAILED with status 0", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await sendWhatsAppMessage(fetchFn, config, {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("SEND_FAILED");
    expect(r.error.context.status).toBe(0);
  });
});
