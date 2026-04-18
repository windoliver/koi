import { describe, expect, test } from "bun:test";
import { createSafeFetcher } from "./safe-fetcher.js";

const publicResolver = async (hostname: string): Promise<readonly string[]> => {
  if (hostname === "public.example.com") return ["93.184.216.34"];
  if (hostname === "private.example.com") return ["127.0.0.1"];
  throw new Error(`ENOTFOUND ${hostname}`);
};

function mockFetch(responses: Readonly<Record<string, Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = responses[url];
    if (res === undefined) throw new Error(`no mock for ${url}`);
    return res;
  }) as typeof fetch;
}

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

async function readBody(body: unknown): Promise<string | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (body instanceof ReadableStream) {
    return await new Response(body).text();
  }
  return String(body);
}

function recordingFetch(responses: Readonly<Record<string, Response>>): {
  readonly fn: typeof fetch;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = await readBody(init?.body);
    calls.push({ url, method: init?.method ?? "GET", body, headers });
    const res = responses[url];
    if (res === undefined) throw new Error(`no mock for ${url}`);
    return res;
  }) as typeof fetch;
  return { fn, calls };
}

describe("createSafeFetcher", () => {
  test("passes through safe request", async () => {
    const safeFetch = createSafeFetcher(
      mockFetch({ "https://public.example.com/ok": new Response("hi", { status: 200 }) }),
      { dnsResolver: publicResolver },
    );
    const res = await safeFetch("https://public.example.com/ok");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
  });

  test("blocks initial URL if private", async () => {
    const safeFetch = createSafeFetcher(mockFetch({}), { dnsResolver: publicResolver });
    await expect(safeFetch("http://127.0.0.1/")).rejects.toThrow(/Blocked/);
  });

  test("revalidates on redirect — blocks public→private", async () => {
    const safeFetch = createSafeFetcher(
      mockFetch({
        "https://public.example.com/redirect": new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        }),
      }),
      { dnsResolver: publicResolver },
    );
    await expect(safeFetch("https://public.example.com/redirect")).rejects.toThrow(
      /Blocked|169\.254\.169\.254/,
    );
  });

  test("follows safe redirect", async () => {
    const safeFetch = createSafeFetcher(
      mockFetch({
        "https://public.example.com/r": new Response(null, {
          status: 302,
          headers: { Location: "https://public.example.com/final" },
        }),
        "https://public.example.com/final": new Response("done", { status: 200 }),
      }),
      { dnsResolver: publicResolver },
    );
    const res = await safeFetch("https://public.example.com/r");
    expect(await res.text()).toBe("done");
  });

  test("303 redirect downgrades POST to GET and drops body", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/post": new Response(null, {
        status: 303,
        headers: { Location: "https://public.example.com/after" },
      }),
      "https://public.example.com/after": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const res = await safeFetch("https://public.example.com/post", {
      method: "POST",
      body: "payload",
      headers: { "Content-Type": "text/plain", "X-Trace": "keep" },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe("payload");
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.body).toBeNull();
    expect(calls[1]?.headers["content-type"]).toBeUndefined();
    // Non-content headers must be preserved across hops.
    expect(calls[1]?.headers["x-trace"]).toBe("keep");
  });

  test("302 redirect downgrades POST to GET (browser-aligned)", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/post": new Response(null, {
        status: 302,
        headers: { Location: "https://public.example.com/after" },
      }),
      "https://public.example.com/after": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await safeFetch("https://public.example.com/post", { method: "POST", body: "payload" });
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.body).toBeNull();
  });

  test("307 redirect preserves method and body", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/post": new Response(null, {
        status: 307,
        headers: { Location: "https://public.example.com/after" },
      }),
      "https://public.example.com/after": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await safeFetch("https://public.example.com/post", {
      method: "POST",
      body: "payload",
      headers: { "Content-Type": "text/plain" },
    });
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.body).toBe("payload");
    expect(calls[1]?.headers["content-type"]).toBe("text/plain");
  });

  test("Request input preserves method, headers, body", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/echo": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const req = new Request("https://public.example.com/echo", {
      method: "POST",
      body: "hello",
      headers: { "Content-Type": "text/plain", "X-Custom": "1" },
    });
    await safeFetch(req);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe("hello");
    expect(calls[0]?.headers["content-type"]).toBe("text/plain");
    expect(calls[0]?.headers["x-custom"]).toBe("1");
  });

  test("caps at maxRedirects", async () => {
    const safeFetch = createSafeFetcher(
      mockFetch({
        "https://public.example.com/a": new Response(null, {
          status: 302,
          headers: { Location: "https://public.example.com/b" },
        }),
        "https://public.example.com/b": new Response(null, {
          status: 302,
          headers: { Location: "https://public.example.com/c" },
        }),
        "https://public.example.com/c": new Response(null, {
          status: 302,
          headers: { Location: "https://public.example.com/a" },
        }),
      }),
      { dnsResolver: publicResolver, maxRedirects: 2 },
    );
    await expect(safeFetch("https://public.example.com/a")).rejects.toThrow(/redirects/);
  });
});
