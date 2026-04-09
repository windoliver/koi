/**
 * Integration test — exercises the HTTP hook executor end-to-end with
 * a real local HTTP server and the SSRF guard + header sanitization.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { HookEvent, HttpHookConfig } from "@koi/core";
import { executeHooks } from "../executor.js";
import type { DnsResolverFn } from "../ssrf.js";

// ---------------------------------------------------------------------------
// Test HTTP server
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let serverPort: number;
/** URL with hostname (not IP) so DNS resolver is exercised. */
let hookUrl: string;
const receivedRequests: Array<{
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random available port
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.text();
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      receivedRequests.push({ method: req.method, headers, body });
      return new Response(JSON.stringify({ decision: "continue" }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  serverPort = server.port ?? 0;
  // Use "localhost" hostname so the DNS resolver is called (not IP literal path)
  hookUrl = `http://localhost:${serverPort}`;
});

afterAll(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_EVENT: HookEvent = {
  event: "tool.before",
  agentId: "test-agent",
  sessionId: "test-session",
  data: { tool: "test-tool" },
};

function httpHook(overrides: Partial<HttpHookConfig> = {}): readonly HttpHookConfig[] {
  return [
    {
      kind: "http",
      name: "test-hook",
      url: `${hookUrl}/hook`,
      ...overrides,
    },
  ];
}

/** Mock resolver that returns whatever IPs you specify. */
const mockResolver =
  (ips: readonly string[]): DnsResolverFn =>
  async () =>
    ips;

/** Resolver that returns 127.0.0.1 — the real IP the server is on. */
const localhostResolver = mockResolver(["127.0.0.1"]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSRF integration", () => {
  it("allows hook to public IP (via mock resolver)", async () => {
    const before = receivedRequests.length;
    const results = await executeHooks(
      httpHook(),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      localhostResolver,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(receivedRequests.length).toBe(before + 1);
    expect(receivedRequests[receivedRequests.length - 1]?.body).toContain("test-tool");
  });

  it("blocks hook resolving to cloud metadata IP", async () => {
    const metadataResolver = mockResolver(["169.254.169.254"]);
    const results = await executeHooks(
      httpHook(),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      metadataResolver,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (results[0] !== undefined && !results[0].ok) {
      expect(results[0].error).toContain("SSRF blocked");
      expect(results[0].error).toContain("169.254.169.254");
    }
  });

  it("blocks hook resolving to private 10.x IP", async () => {
    const results = await executeHooks(
      httpHook(),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      mockResolver(["10.0.0.1"]),
    );
    expect(results[0]?.ok).toBe(false);
    if (results[0] !== undefined && !results[0].ok) {
      expect(results[0].error).toContain("SSRF blocked");
    }
  });

  it("blocks when any resolved IP is private (mixed results)", async () => {
    const results = await executeHooks(
      httpHook(),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      mockResolver(["93.184.216.34", "192.168.1.1"]),
    );
    expect(results[0]?.ok).toBe(false);
  });

  it("blocks hook to IPv4-mapped IPv6 private address", async () => {
    const results = await executeHooks(
      httpHook(),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      mockResolver(["::ffff:169.254.169.254"]),
    );
    expect(results[0]?.ok).toBe(false);
    if (results[0] !== undefined && !results[0].ok) {
      expect(results[0].error).toContain("SSRF blocked");
    }
  });
});

describe("Header sanitization integration", () => {
  it("rejects headers with CRLF injection", async () => {
    const results = await executeHooks(
      httpHook({ headers: { Authorization: "Bearer token\r\nX-Evil: injected" } }),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      localhostResolver,
    );
    expect(results[0]?.ok).toBe(false);
    if (results[0] !== undefined && !results[0].ok) {
      expect(results[0].error).toContain("header injection");
    }
  });

  it("rejects reserved Host header", async () => {
    const results = await executeHooks(
      httpHook({ headers: { Host: "evil.com" } }),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      localhostResolver,
    );
    expect(results[0]?.ok).toBe(false);
    if (results[0] !== undefined && !results[0].ok) {
      expect(results[0].error).toContain("reserved");
    }
  });

  it("rejects reserved Transfer-Encoding header", async () => {
    const results = await executeHooks(
      httpHook({ headers: { "Transfer-Encoding": "chunked" } }),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      localhostResolver,
    );
    expect(results[0]?.ok).toBe(false);
  });

  it("allows valid custom headers", async () => {
    const _before = receivedRequests.length;
    const results = await executeHooks(
      httpHook({ headers: { "X-Custom": "safe-value", Authorization: "Bearer abc123" } }),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      localhostResolver,
    );
    expect(results[0]?.ok).toBe(true);
    const lastReq = receivedRequests[receivedRequests.length - 1];
    expect(lastReq?.headers["x-custom"]).toBe("safe-value");
    expect(lastReq?.headers.authorization).toBe("Bearer abc123");
  });
});

describe("Env-var allowlisting integration", () => {
  it("blocks env var not in hook allowlist", async () => {
    process.env.SECRET_DB_URL = "postgres://secret@db:5432/prod";
    try {
      const results = await executeHooks(
        httpHook({
          headers: { "X-Db": "${SECRET_DB_URL}" },
          allowedEnvVars: ["HOOK_TOKEN"], // SECRET_DB_URL not in list
        }),
        MOCK_EVENT,
        undefined,
        undefined,
        undefined,
        undefined,
        localhostResolver,
      );
      expect(results[0]?.ok).toBe(false);
      if (results[0] !== undefined && !results[0].ok) {
        expect(results[0].error).toContain("denied");
      }
    } finally {
      delete process.env.SECRET_DB_URL;
    }
  });

  it("expands allowed env var successfully", async () => {
    process.env.HOOK_TEST_INTEGRATION = "integration-value";
    try {
      const _before = receivedRequests.length;
      const results = await executeHooks(
        httpHook({
          headers: { "X-Token": "${HOOK_TEST_INTEGRATION}" },
          allowedEnvVars: ["HOOK_TEST_INTEGRATION"],
        }),
        MOCK_EVENT,
        undefined,
        undefined,
        undefined,
        undefined,
        localhostResolver,
      );
      expect(results[0]?.ok).toBe(true);
      const lastReq = receivedRequests[receivedRequests.length - 1];
      expect(lastReq?.headers["x-token"]).toBe("integration-value");
    } finally {
      delete process.env.HOOK_TEST_INTEGRATION;
    }
  });
});

describe("IP pinning integration", () => {
  it("pins HTTP URL to resolved IP with Host header", async () => {
    const _before = receivedRequests.length;
    const results = await executeHooks(
      httpHook(),
      MOCK_EVENT,
      undefined,
      undefined,
      undefined,
      undefined,
      localhostResolver,
    );
    expect(results[0]?.ok).toBe(true);
    // The request was pinned to 127.0.0.1 but Host header preserves original hostname
    const lastReq = receivedRequests[receivedRequests.length - 1];
    expect(lastReq?.headers.host).toContain("localhost");
  });
});
