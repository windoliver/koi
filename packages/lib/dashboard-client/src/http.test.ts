import { describe, expect, test } from "bun:test";
import { getJson } from "./http.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Tests in this file focus on envelope/transport behavior, not payload shape.
// `accept` is a pass-through validator; payload-shape tests live in client.test.ts.
const accept = <T>(): ((value: unknown) => value is T) =>
  ((_value: unknown): boolean => true) as (value: unknown) => value is T;

describe("getJson", () => {
  test("unwraps a successful ApiResult envelope", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ ok: true, value: [{ x: 1 }] });
    const result = await getJson<readonly { x: number }[]>(fetchImpl, "http://x/api/y", {
      validate: accept<readonly { x: number }[]>(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ x: 1 }]);
  });

  test("forwards a server error envelope", async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse({
        ok: false,
        error: { code: "NOT_FOUND", message: "missing", retryable: false },
      });
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("maps 404 to NOT_FOUND without parsing the body", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("", { status: 404 });
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("maps 500 to retryable EXTERNAL", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("oops", { status: 500 });
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("maps 429 to RATE_LIMIT (retryable)", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("", { status: 429 });
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
    }
  });

  test("maps fetch throw to retryable EXTERNAL (transient transport failures dominate)", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("dns failure");
    };
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  test("treats AbortError as non-retryable EXTERNAL", async () => {
    const fetchImpl = async (): Promise<Response> => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("rejects ok:true envelope without `value` by default (list endpoints fail fast)", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ ok: true });
    const result = await getJson<readonly unknown[]>(fetchImpl, "http://x/api/y", {
      validate: accept<readonly unknown[]>(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("treats ok:true envelope without `value` as undefined when opted in", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ ok: true });
    const result = await getJson<unknown>(fetchImpl, "http://x/api/y", {
      validate: accept<unknown>(),
      allowUndefinedValue: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });

  test("rejects ok:false envelope without a well-formed error", async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse({ ok: false, error: { code: 1 } });
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("tolerates server error envelope missing retryable (defaults locally)", async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse({ ok: false, error: { code: "TIMEOUT", message: "slow" } });
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.message).toBe("slow");
      // RETRYABLE_DEFAULTS["TIMEOUT"] === true
      expect(result.error.retryable).toBe(true);
    }
  });

  test("maps unknown server error code to EXTERNAL while preserving message", async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse({
        ok: false,
        error: { code: "FUTURE_CODE", message: "from a newer server" },
      });
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toBe("from a newer server");
    }
  });

  test("maps non-JSON body to VALIDATION", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response("<html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("maps malformed envelope to VALIDATION", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ value: 42 });
    const result = await getJson(fetchImpl, "http://x/api/y", { validate: accept() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns VALIDATION instead of throwing when validate is missing (JS-caller safety)", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ ok: true, value: 1 });
    // @ts-expect-error — simulating a JS caller that omitted the typed options
    const result = await getJson(fetchImpl, "http://x/api/y");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });
});
