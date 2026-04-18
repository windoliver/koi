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

  test("strips Authorization/Cookie on cross-origin redirect", async () => {
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
        "X-Trace": "keep",
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret");
    expect(calls[0]?.headers["cookie"]).toBe("session=abc");
    expect(calls[1]?.headers["authorization"]).toBeUndefined();
    expect(calls[1]?.headers["cookie"]).toBeUndefined();
    // Non-credential headers preserved.
    expect(calls[1]?.headers["x-trace"]).toBe("keep");
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
