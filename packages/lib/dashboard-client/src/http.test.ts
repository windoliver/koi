import { describe, expect, test } from "bun:test";
import { getJson } from "./http.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getJson", () => {
  test("unwraps a successful ApiResult envelope", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ ok: true, value: [{ x: 1 }] });
    const result = await getJson<readonly { x: number }[]>(fetchImpl, "http://x/api/y");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([{ x: 1 }]);
  });

  test("forwards a server error envelope", async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse({
        ok: false,
        error: { code: "NOT_FOUND", message: "missing", retryable: false },
      });
    const result = await getJson(fetchImpl, "http://x/api/y");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("maps 404 to NOT_FOUND without parsing the body", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("", { status: 404 });
    const result = await getJson(fetchImpl, "http://x/api/y");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("maps 500 to EXTERNAL", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("oops", { status: 500 });
    const result = await getJson(fetchImpl, "http://x/api/y");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EXTERNAL");
  });

  test("maps fetch throw to EXTERNAL", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("dns failure");
    };
    const result = await getJson(fetchImpl, "http://x/api/y");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  test("maps non-JSON body to VALIDATION", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response("<html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const result = await getJson(fetchImpl, "http://x/api/y");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("maps malformed envelope to VALIDATION", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ value: 42 });
    const result = await getJson(fetchImpl, "http://x/api/y");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });
});
