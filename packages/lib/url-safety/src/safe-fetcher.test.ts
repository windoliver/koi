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
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (body instanceof ReadableStream) return await new Response(body).text();
  return String(body);
}

function recordingFetch(responses: Readonly<Record<string, Response>>): {
  readonly fn: typeof fetch;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    // When input is a Request, its properties combine with any init overrides
    // (native fetch semantics). Read the effective method/headers/body so
    // the recording works for both `fetch(url, init)` and `fetch(request)`
    // call shapes.
    const reqInput = input instanceof Request ? input : undefined;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    const effectiveHeaders = new Headers(init?.headers ?? reqInput?.headers);
    effectiveHeaders.forEach((v, k) => {
      headers[k] = v;
    });
    const rawBody = init?.body ?? (reqInput !== undefined ? reqInput.body : undefined);
    const body = await readBody(rawBody);
    const method = init?.method ?? reqInput?.method ?? "GET";
    calls.push({ url, method, body, headers });
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

  test("rejects GET with body (matches native fetch TypeError contract)", async () => {
    const safeFetch = createSafeFetcher(mockFetch({}), { dnsResolver: publicResolver });
    await expect(
      safeFetch("https://public.example.com/x", { method: "GET", body: "nope" }),
    ).rejects.toThrow(/GET request cannot have a body/i);
  });

  test("rejects HEAD with body", async () => {
    const safeFetch = createSafeFetcher(mockFetch({}), { dnsResolver: publicResolver });
    await expect(
      safeFetch("https://public.example.com/x", { method: "HEAD", body: "nope" }),
    ).rejects.toThrow(/HEAD request cannot have a body/i);
  });

  test("303 redirect preserves HEAD (fetch spec: HEAD stays HEAD)", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/start": new Response(null, {
        status: 303,
        headers: { Location: "https://public.example.com/final" },
      }),
      "https://public.example.com/final": new Response(null, { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await safeFetch("https://public.example.com/start", { method: "HEAD" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("HEAD");
    // 303 + HEAD must NOT be rewritten to GET.
    expect(calls[1]?.method).toBe("HEAD");
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

  test("redacts all non-safelisted headers on cross-origin redirect", async () => {
    const resolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "a.example.com") return ["93.184.216.34"];
      if (hostname === "b.example.com") return ["93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const { fn, calls } = recordingFetch({
      "https://a.example.com/start": new Response(null, {
        status: 302,
        headers: { Location: "https://b.example.com/end" },
      }),
      "https://b.example.com/end": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: resolver });
    await safeFetch("https://a.example.com/start", {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=abc",
        "X-API-Key": "k",
        "X-Amz-Security-Token": "t",
        "X-Trace": "keep",
        Accept: "application/json",
      },
    });
    expect(calls).toHaveLength(2);
    // First hop: caller-set headers all survive.
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret");
    expect(calls[0]?.headers["x-api-key"]).toBe("k");
    // Second hop: everything except the safelist is redacted — denylist
    // was too narrow; custom auth headers like x-api-key/x-amz-security-token
    // are exactly what hostile redirects try to exfiltrate.
    expect(calls[1]?.headers["authorization"]).toBeUndefined();
    expect(calls[1]?.headers["cookie"]).toBeUndefined();
    expect(calls[1]?.headers["x-api-key"]).toBeUndefined();
    expect(calls[1]?.headers["x-amz-security-token"]).toBeUndefined();
    expect(calls[1]?.headers["x-trace"]).toBeUndefined();
    // Safelist headers do survive (content-negotiation only).
    expect(calls[1]?.headers["accept"]).toBe("application/json");
  });

  test("refuses cross-origin 307 redirect with body (body exfiltration defence)", async () => {
    const resolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "a.example.com") return ["93.184.216.34"];
      if (hostname === "b.example.com") return ["93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const { fn } = recordingFetch({
      "https://a.example.com/post": new Response(null, {
        status: 307,
        headers: { Location: "https://b.example.com/steal" },
      }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: resolver });
    await expect(
      safeFetch("https://a.example.com/post", {
        method: "POST",
        body: JSON.stringify({ api_key: "secret" }),
        headers: { "Content-Type": "application/json" },
      }),
    ).rejects.toThrow(/cross-origin 307|replay the request body/i);
  });

  test("refuses cross-origin 308 redirect with body", async () => {
    const resolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "a.example.com") return ["93.184.216.34"];
      if (hostname === "b.example.com") return ["93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const { fn } = recordingFetch({
      "https://a.example.com/put": new Response(null, {
        status: 308,
        headers: { Location: "https://b.example.com/final" },
      }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: resolver });
    await expect(
      safeFetch("https://a.example.com/put", { method: "PUT", body: "payload" }),
    ).rejects.toThrow(/cross-origin 308/i);
  });

  test("refuses cross-origin 302 redirect with PUT body (body exfiltration defence)", async () => {
    const resolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "a.example.com") return ["93.184.216.34"];
      if (hostname === "b.example.com") return ["93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const { fn } = recordingFetch({
      "https://a.example.com/put": new Response(null, {
        status: 302,
        headers: { Location: "https://b.example.com/steal" },
      }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: resolver });
    await expect(
      safeFetch("https://a.example.com/put", {
        method: "PUT",
        body: JSON.stringify({ api_key: "secret" }),
      }),
    ).rejects.toThrow(/cross-origin 302|body replay/i);
  });

  test("refuses cross-origin 301 redirect with PATCH body", async () => {
    const resolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "a.example.com") return ["93.184.216.34"];
      if (hostname === "b.example.com") return ["93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const { fn } = recordingFetch({
      "https://a.example.com/patch": new Response(null, {
        status: 301,
        headers: { Location: "https://b.example.com/final" },
      }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: resolver });
    await expect(
      safeFetch("https://a.example.com/patch", { method: "PATCH", body: "delta" }),
    ).rejects.toThrow(/cross-origin 301/i);
  });

  test("allows cross-origin 302 with POST (body dropped by downgrade)", async () => {
    const resolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "a.example.com") return ["93.184.216.34"];
      if (hostname === "b.example.com") return ["93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const { fn, calls } = recordingFetch({
      "https://a.example.com/post": new Response(null, {
        status: 302,
        headers: { Location: "https://b.example.com/final" },
      }),
      "https://b.example.com/final": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: resolver });
    const res = await safeFetch("https://a.example.com/post", {
      method: "POST",
      body: "payload",
    });
    expect(res.status).toBe(200);
    // POST + 302 downgrades to GET with no body → cross-origin follow is safe.
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.body).toBeNull();
  });

  test("allows cross-origin 307 without body (idempotent request, no exfil risk)", async () => {
    const resolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "a.example.com") return ["93.184.216.34"];
      if (hostname === "b.example.com") return ["93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const { fn, calls } = recordingFetch({
      "https://a.example.com/start": new Response(null, {
        status: 307,
        headers: { Location: "https://b.example.com/end" },
      }),
      "https://b.example.com/end": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: resolver });
    const res = await safeFetch("https://a.example.com/start");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("init.headers replaces Request headers (native fetch semantics)", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const req = new Request("https://public.example.com/x", {
      headers: {
        Authorization: "Bearer stale",
        "X-API-Key": "stale",
      },
    });
    await safeFetch(req, { headers: { "X-New": "1" } });
    expect(calls).toHaveLength(1);
    // init.headers replaces — stale credentials on the Request must not leak.
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
    expect(calls[0]?.headers["x-api-key"]).toBeUndefined();
    expect(calls[0]?.headers["x-new"]).toBe("1");
  });

  test("init.headers={} clears Request headers", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const req = new Request("https://public.example.com/x", {
      headers: { Authorization: "Bearer stale" },
    });
    await safeFetch(req, { headers: {} });
    // Caller explicitly cleared — no stale headers may survive.
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
  });

  test("refuses http:// with custom dispatcher by default", async () => {
    const { fn } = recordingFetch({
      "http://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const dispatcher: unknown = { kind: "test-dispatcher" };
    await expect(
      safeFetch("http://public.example.com/x", { dispatcher } as unknown as RequestInit),
    ).rejects.toThrow(/dispatcher|agent|bypass/i);
  });

  test("refuses https:// with custom dispatcher by default (transport can bypass pin)", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const dispatcher: unknown = { kind: "test-dispatcher" };
    await expect(
      safeFetch("https://public.example.com/x", { dispatcher } as unknown as RequestInit),
    ).rejects.toThrow(/dispatcher|agent|bypass/i);
  });

  test("custom-transport rejection does NOT consume stream body", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/up": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const dispatcher: unknown = { kind: "test-dispatcher" };
    let pullCount = 0;
    const stream = new ReadableStream({
      pull(c) {
        pullCount += 1;
        c.enqueue(new TextEncoder().encode("x"));
      },
    });
    await expect(
      safeFetch("https://public.example.com/up", {
        method: "POST",
        body: stream,
        dispatcher,
      } as unknown as RequestInit),
    ).rejects.toThrow(/dispatcher|agent|bypass/i);
    // ReadableStream may prime one chunk. Our bufferBody would keep pulling;
    // verify that didn't happen — rejection must come before body buffering.
    expect(pullCount).toBeLessThanOrEqual(1);
  });

  test("trustCustomTransport=true opts into caller-enforced egress policy", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, {
      dnsResolver: publicResolver,
      trustCustomTransport: true,
    });
    const dispatcher: unknown = { kind: "test-dispatcher" };
    await safeFetch("https://public.example.com/x", { dispatcher } as unknown as RequestInit);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://public.example.com/x");
  });

  test("returns 304/300/305 with Location without following (non-redirect 3xx)", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/notmod": new Response(null, {
        status: 304,
        headers: { Location: "https://evil.example.com/exfil" },
      }),
      "https://public.example.com/multi": new Response(null, {
        status: 300,
        headers: { Location: "https://evil.example.com/exfil" },
      }),
      "https://public.example.com/useproxy": new Response(null, {
        status: 305,
        headers: { Location: "https://evil.example.com/exfil" },
      }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });

    const r1 = await safeFetch("https://public.example.com/notmod");
    expect(r1.status).toBe(304);

    const r2 = await safeFetch("https://public.example.com/multi");
    expect(r2.status).toBe(300);

    const r3 = await safeFetch("https://public.example.com/useproxy");
    expect(r3.status).toBe(305);

    // Only 3 requests total — none of the 3xx responses followed the Location.
    expect(calls).toHaveLength(3);
  });

  test("passes Request object through so internal transport state survives (hop 0)", async () => {
    // Internal undici dispatcher / credentials-behaviour state on a Request
    // sits on symbols that aren't introspectable from JS. Reconstructing a
    // fresh fetch(url, init) would drop that state — we instead pass the
    // Request object itself to base on hop 0 so those guarantees survive.
    // This test verifies base() receives the Request reference when input
    // was a Request and the caller didn't override init.headers.
    const seen: Array<{ input: unknown; kind: string }> = [];
    const fn = (async (input: string | URL | Request) => {
      seen.push({ input, kind: input instanceof Request ? "Request" : "url" });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const req = new Request("https://public.example.com/x");
    await safeFetch(req);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("Request");
  });

  test("preserves dispatcher/agent init options (proxy/egress transport, opt-in)", async () => {
    const capturedInits: RequestInit[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedInits.push(init ?? {});
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const safeFetch = createSafeFetcher(fn, {
      dnsResolver: publicResolver,
      trustCustomTransport: true,
    });
    const dispatcher: unknown = { kind: "test-dispatcher" };
    const agent: unknown = { kind: "test-agent" };
    const initArg = { dispatcher, agent } as unknown as RequestInit;
    await safeFetch("https://public.example.com/x", initArg);
    const first = capturedInits[0] as Record<string, unknown>;
    expect(first["dispatcher"]).toBe(dispatcher);
    expect(first["agent"]).toBe(agent);
  });

  test("omitting init.headers inherits from Request (no regression for common case)", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const req = new Request("https://public.example.com/x", {
      headers: { "X-Trace": "abc" },
    });
    await safeFetch(req);
    expect(calls[0]?.headers["x-trace"]).toBe("abc");
  });

  test("rejects Request with bodyUsed=true when no replacement body provided", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const req = new Request("https://public.example.com/x", {
      method: "POST",
      body: "payload",
      headers: { "Content-Type": "text/plain" },
    });
    await req.text();
    expect(req.bodyUsed).toBe(true);
    await expect(safeFetch(req)).rejects.toThrow(/bodyUsed|consumed/i);
  });

  test("accepts bodyUsed Request when init.body provides a replacement", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const req = new Request("https://public.example.com/x", {
      method: "POST",
      body: "original",
      headers: { "Content-Type": "text/plain" },
    });
    // Middleware pattern: log/sign/transform the original, then re-send with
    // a transformed body on the same Request.
    await req.text();
    expect(req.bodyUsed).toBe(true);
    const res = await safeFetch(req, { body: "replacement" });
    expect(res.status).toBe(200);
    expect(calls[0]?.body).toBe("replacement");
  });

  test("keeps Authorization on same-origin redirect", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/start": new Response(null, {
        status: 302,
        headers: { Location: "https://public.example.com/end" },
      }),
      "https://public.example.com/end": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await safeFetch("https://public.example.com/start", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(calls[1]?.headers["authorization"]).toBe("Bearer secret");
  });

  test("buffers ReadableStream body so 307 can replay", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/upload": new Response(null, {
        status: 307,
        headers: { Location: "https://public.example.com/final" },
      }),
      "https://public.example.com/final": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("payload"));
        controller.close();
      },
    });
    const res = await safeFetch("https://public.example.com/upload", {
      method: "POST",
      body: stream,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe("payload");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.body).toBe("payload");
  });

  test("Request POST with body can follow 307 after buffering", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/upload": new Response(null, {
        status: 307,
        headers: { Location: "https://public.example.com/final" },
      }),
      "https://public.example.com/final": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const req = new Request("https://public.example.com/upload", {
      method: "POST",
      body: "hello",
      headers: { "Content-Type": "text/plain" },
    });
    const res = await safeFetch(req);
    expect(res.status).toBe(200);
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.body).toBe("hello");
  });

  test("pins HTTP URL to resolved IP and sets Host header", async () => {
    const { fn, calls } = recordingFetch({
      "http://93.184.216.34/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await safeFetch("http://public.example.com/x");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://93.184.216.34/x");
    expect(calls[0]?.headers["host"]).toBe("public.example.com");
  });

  test("does not pin HTTPS URLs (TLS SNI constraint)", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await safeFetch("https://public.example.com/x");
    expect(calls[0]?.url).toBe("https://public.example.com/x");
    expect(calls[0]?.headers["host"]).toBeUndefined();
  });

  test("clears pinned Host header on http→https redirect", async () => {
    const { fn, calls } = recordingFetch({
      "http://93.184.216.34/start": new Response(null, {
        status: 307,
        headers: { Location: "https://public.example.com/final" },
      }),
      "https://public.example.com/final": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await safeFetch("http://public.example.com/start");
    expect(calls).toHaveLength(2);
    // Hop 0 pinned http → IP + host header.
    expect(calls[0]?.url).toBe("http://93.184.216.34/start");
    expect(calls[0]?.headers["host"]).toBe("public.example.com");
    // Hop 1 https: URL must not carry the stale synthetic host.
    expect(calls[1]?.url).toBe("https://public.example.com/final");
    expect(calls[1]?.headers["host"]).toBeUndefined();
  });

  test("rejects request body exceeding maxBufferedBodyBytes", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/up": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, {
      dnsResolver: publicResolver,
      maxBufferedBodyBytes: 4,
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.close();
      },
    });
    await expect(
      safeFetch("https://public.example.com/up", {
        method: "POST",
        body: stream,
      }),
    ).rejects.toThrow(/maxBufferedBodyBytes/);
  });

  test("rejects stream body when maxBufferedBodyBytes=0 (strict streaming mode)", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/up": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, {
      dnsResolver: publicResolver,
      maxBufferedBodyBytes: 0,
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
        controller.close();
      },
    });
    await expect(
      safeFetch("https://public.example.com/up", {
        method: "POST",
        body: stream,
      }),
    ).rejects.toThrow(/not supported/);
  });

  test("multi-IP HTTP pins to first resolved IP and falls over to next on connect error", async () => {
    const multiResolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "dual.example.com") return ["93.184.216.34", "93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const attempts: string[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      attempts.push(url);
      const headers = new Headers(init?.headers);
      // First IP fails to connect; second IP succeeds.
      if (url === "http://93.184.216.34/x") throw new TypeError("ECONNREFUSED");
      if (url === "http://93.184.216.35/x") {
        expect(headers.get("host")).toBe("dual.example.com");
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const safeFetch = createSafeFetcher(fn, { dnsResolver: multiResolver });
    const res = await safeFetch("http://dual.example.com/x");
    expect(res.status).toBe(200);
    expect(attempts).toEqual(["http://93.184.216.34/x", "http://93.184.216.35/x"]);
  });

  test("multi-IP HTTP pins each validated IP (closes rebind window)", async () => {
    const multiResolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "dual.example.com") return ["93.184.216.34", "93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const { fn, calls } = recordingFetch({
      "http://93.184.216.34/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: multiResolver });
    await safeFetch("http://dual.example.com/x");
    expect(calls).toHaveLength(1);
    // URL is rewritten to first IP; Host header carries the original hostname.
    expect(calls[0]?.url).toBe("http://93.184.216.34/x");
    expect(calls[0]?.headers["host"]).toBe("dual.example.com");
  });

  test("DELETE is NOT auto-retried across IPs (ambiguous destructive failure)", async () => {
    const multiResolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "dual.example.com") return ["93.184.216.34", "93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const attempts: string[] = [];
    const fn = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      attempts.push(url);
      throw new TypeError("ECONNRESET");
    }) as unknown as typeof fetch;
    const safeFetch = createSafeFetcher(fn, { dnsResolver: multiResolver });
    await expect(
      safeFetch("http://dual.example.com/resource", { method: "DELETE" }),
    ).rejects.toThrow(/ECONNRESET/);
    // Only one attempt — DELETE is not retried.
    expect(attempts).toHaveLength(1);
  });

  test("multi-IP pin throws if all IPs unreachable", async () => {
    const multiResolver = async (hostname: string): Promise<readonly string[]> => {
      if (hostname === "dual.example.com") return ["93.184.216.34", "93.184.216.35"];
      throw new Error(`ENOTFOUND ${hostname}`);
    };
    const fn = (async () => {
      throw new TypeError("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const safeFetch = createSafeFetcher(fn, { dnsResolver: multiResolver });
    await expect(safeFetch("http://dual.example.com/x")).rejects.toThrow(/ECONNREFUSED/);
  });

  test("rejects blocked URL before consuming any stream body bytes", async () => {
    const { fn } = recordingFetch({});
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    let readCount = 0;
    const stream = new ReadableStream({
      pull(controller) {
        readCount += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        if (readCount >= 3) controller.close();
      },
    });
    await expect(safeFetch("http://127.0.0.1/", { method: "POST", body: stream })).rejects.toThrow(
      /Blocked/,
    );
    // ReadableStream may prime exactly one chunk into its internal queue before
    // anyone calls getReader(). The important invariant is that our bufferBody
    // did NOT start draining it (which would keep pulling until close). So we
    // tolerate the one prime but would see readCount===3 if draining had begun.
    expect(readCount).toBeLessThanOrEqual(1);
  });

  test("aborts stream buffering when signal is already triggered", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/up": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const controller = new AbortController();
    controller.abort();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("payload"));
        c.close();
      },
    });
    await expect(
      safeFetch("https://public.example.com/up", {
        method: "POST",
        body: stream,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
  });

  test("interrupts an in-flight stream read when signal aborts mid-buffer", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/up": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const controller = new AbortController();
    // Stream never produces more data until we abort; reader.read() is stuck pending.
    let cancelCalled = false;
    const stream = new ReadableStream({
      pull(_c) {
        // Intentionally never resolve — simulates a stalled upstream.
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelCalled = true;
      },
    });
    const promise = safeFetch("https://public.example.com/up", {
      method: "POST",
      body: stream,
      signal: controller.signal,
    });
    // Abort after a microtask so the read is already pending.
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
    // Give the reader.cancel() a tick to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelCalled).toBe(true);
  });

  test("redirect: 'manual' passes stream body through without buffering", async () => {
    // Caller doesn't need redirect replay → no preflight buffering. Large
    // streams pass through with their backpressure intact.
    const capturedInits: RequestInit[] = [];
    const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInits.push(init ?? {});
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("streamed"));
        c.close();
      },
    });
    await safeFetch("https://public.example.com/up", {
      method: "POST",
      body: stream,
      redirect: "manual",
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const first = capturedInits[0] as Record<string, unknown>;
    // Body passes through as ReadableStream (not buffered).
    expect(first["body"]).toBeInstanceOf(ReadableStream);
    // Duplex MUST survive when body is stream-backed — Node 22 fetch would
    // throw without it. Regression for the Round 10 bug where toInit stripped
    // duplex unconditionally.
    expect(first["duplex"]).toBe("half");
  });

  test("buffered body strips duplex (no longer a stream after bufferBody)", async () => {
    // Opposite side of the duplex rule: when we buffer the stream to a
    // Uint8Array (redirect: "follow" default path), duplex is moot and we
    // strip it so the outgoing init accurately describes the payload.
    const capturedInits: RequestInit[] = [];
    const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInits.push(init ?? {});
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("hi"));
        c.close();
      },
    });
    await safeFetch("https://public.example.com/up", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const first = capturedInits[0] as Record<string, unknown>;
    expect(first["body"]).toBeInstanceOf(Uint8Array);
    expect(first["duplex"]).toBeUndefined();
  });

  test("honours redirect: 'manual' — returns 3xx without following", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/r": new Response(null, {
        status: 302,
        headers: { Location: "https://public.example.com/final" },
      }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const res = await safeFetch("https://public.example.com/r", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://public.example.com/final");
    expect(calls).toHaveLength(1);
  });

  test("honours redirect: 'error' — throws on 3xx", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/r": new Response(null, {
        status: 302,
        headers: { Location: "https://public.example.com/final" },
      }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await expect(safeFetch("https://public.example.com/r", { redirect: "error" })).rejects.toThrow(
      /unexpected redirect/,
    );
  });

  test("buffers AsyncIterable body so 307 redirect can replay it", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/upload": new Response(null, {
        status: 307,
        headers: { Location: "https://public.example.com/final" },
      }),
      "https://public.example.com/final": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const body = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode("hel");
        yield new TextEncoder().encode("lo");
      },
    };
    const res = await safeFetch("https://public.example.com/upload", {
      method: "POST",
      body: body as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"],
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    // Both hops see the buffered bytes — not a re-iterated (empty) stream.
    expect(calls[0]?.body).toBe("hello");
    expect(calls[1]?.body).toBe("hello");
  });

  test("rejects AsyncIterable chunks of unsupported type", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/up": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const body = {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        yield { not: "bytes" };
      },
    };
    await expect(
      safeFetch("https://public.example.com/up", {
        method: "POST",
        body: body as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"],
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    ).rejects.toThrow(/unsupported chunk type/);
  });

  test("drops caller-supplied duplex after buffering AsyncIterable body", async () => {
    // Since AsyncIterable bodies are now buffered to Uint8Array, duplex is
    // no longer needed on the outgoing request. The wrapper strips it so
    // the downstream init accurately describes a non-streaming body.
    const capturedInits: RequestInit[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedInits.push(init ?? {});
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const body = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield new TextEncoder().encode("hi");
      },
    };
    await safeFetch("https://public.example.com/up", {
      method: "POST",
      body: body as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"],
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const first = capturedInits[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect((first as RequestInit & { duplex?: string }).duplex).toBeUndefined();
    }
  });

  test("Response.url reflects the pinned IP for HTTP-pinned requests (documented)", async () => {
    // When HTTP pinning rewrites the outbound URL to the validated IP, the
    // underlying fetch returns a Response whose .url field is the IP form.
    // Documented limitation — the wrapper does not synthesize a new Response
    // because that would drop streaming body semantics and fetch metadata.
    // Callers that need the original URL should track it themselves.
    const fn = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response("ok", { status: 200, headers: { "X-Seen": url } });
    }) as typeof fetch;
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    const res = await safeFetch("http://public.example.com/x");
    expect(res.status).toBe(200);
    // Underlying fetch saw the pinned URL — that's the documented behaviour.
    expect(res.headers.get("X-Seen")).toBe("http://93.184.216.34/x");
  });

  test("rejects caller-supplied Host by default (authority-spoof guard)", async () => {
    const { fn } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    // Without opt-in, a caller-supplied Host can steer HTTPS past the
    // hostname validator — reverse proxies route on Host after TLS.
    await expect(
      safeFetch("https://public.example.com/x", {
        headers: { Host: "internal.example" },
      }),
    ).rejects.toThrow(/Host header/i);
  });

  test("allowCustomHost: true preserves caller Host across non-pinned requests", async () => {
    // With explicit opt-in, caller Host survives all the way to the wire so
    // virtual-host routing / signed-request flows still work.
    const { fn, calls } = recordingFetch({
      "https://public.example.com/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, {
      dnsResolver: publicResolver,
      allowCustomHost: true,
    });
    await safeFetch("https://public.example.com/x", {
      headers: { Host: "explicit-virtual-host.example.com" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["host"]).toBe("explicit-virtual-host.example.com");
  });

  test("allowCustomHost: true preserves caller Host across same-origin redirect", async () => {
    const { fn, calls } = recordingFetch({
      "https://public.example.com/r": new Response(null, {
        status: 302,
        headers: { Location: "https://public.example.com/final" },
      }),
      "https://public.example.com/final": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, {
      dnsResolver: publicResolver,
      allowCustomHost: true,
    });
    await safeFetch("https://public.example.com/r", {
      headers: { Host: "virtual.example.com" },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["host"]).toBe("virtual.example.com");
    expect(calls[1]?.headers["host"]).toBe("virtual.example.com");
  });

  test("does not pin HTTP IPv6-literal URLs (bracket normalization)", async () => {
    // URL.hostname returns `[2001:4860:4860::8888]` with brackets for an IPv6
    // literal; isSafeUrl stores `2001:4860:4860::8888` without. The pin check
    // must normalise both sides, otherwise IPv6-literal traffic gets a Host
    // header injected and the URL rewritten — breaking legitimate requests.
    const { fn, calls } = recordingFetch({
      "http://[2001:4860:4860::8888]/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await safeFetch("http://[2001:4860:4860::8888]/x");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://[2001:4860:4860::8888]/x");
    expect(calls[0]?.headers["host"]).toBeUndefined();
  });

  test("does not pin HTTP IP-literal URLs (already an IP)", async () => {
    const { fn, calls } = recordingFetch({
      "http://93.184.216.34/x": new Response("ok", { status: 200 }),
    });
    const safeFetch = createSafeFetcher(fn, { dnsResolver: publicResolver });
    await safeFetch("http://93.184.216.34/x");
    expect(calls[0]?.url).toBe("http://93.184.216.34/x");
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
