/**
 * Tests for status probe helpers — injectable fetch for testability.
 */

import { describe, expect, test } from "bun:test";
import {
  detectAdminPort,
  fetchAdminJson,
  probeEndpoint,
  resolveNexusMode,
} from "./status-probes.js";

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

function mockFetch(status: number, body: unknown = {}): FetchFn {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as FetchFn;
}

function mockFetchError(): FetchFn {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as FetchFn;
}

/**
 * Creates a fetch that responds differently per port.
 * @param portResponses Map of port number to HTTP status (missing ports throw).
 */
function mockPortFetch(portResponses: ReadonlyMap<number, number>): FetchFn {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const match = /localhost:(\d+)/.exec(url);
    const port = match !== null ? Number(match[1]) : 0;
    const status = portResponses.get(port);
    if (status === undefined) throw new Error(`ECONNREFUSED on port ${port}`);
    return new Response("{}", { status });
  }) as unknown as FetchFn;
}

// ---------------------------------------------------------------------------
// probeEndpoint
// ---------------------------------------------------------------------------

describe("probeEndpoint", () => {
  test("returns true for HTTP 200", async () => {
    const result = await probeEndpoint("http://localhost:9100/health", 2000, mockFetch(200));
    expect(result).toBe(true);
  });

  test("returns false for HTTP 500", async () => {
    const result = await probeEndpoint("http://localhost:9100/health", 2000, mockFetch(500));
    expect(result).toBe(false);
  });

  test("returns false for network error", async () => {
    const result = await probeEndpoint("http://localhost:9100/health", 2000, mockFetchError());
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectAdminPort
// ---------------------------------------------------------------------------

describe("detectAdminPort", () => {
  test("finds port on first try (3100)", async () => {
    const responses = new Map([[3100, 200]]);
    const result = await detectAdminPort(2000, mockPortFetch(responses));
    expect(result.port).toBe(3100);
    expect(result.ok).toBe(true);
  });

  test("finds port on later port (3103)", async () => {
    const responses = new Map([[3103, 200]]);
    const result = await detectAdminPort(2000, mockPortFetch(responses));
    expect(result.port).toBe(3103);
    expect(result.ok).toBe(true);
  });

  test("returns default when all fail", async () => {
    const result = await detectAdminPort(2000, mockFetchError());
    expect(result.port).toBe(3100);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchAdminJson
// ---------------------------------------------------------------------------

describe("fetchAdminJson", () => {
  test("returns parsed JSON on 200", async () => {
    const body = { agents: [{ name: "test" }] };
    const result = await fetchAdminJson<{ readonly agents: readonly { readonly name: string }[] }>(
      "http://localhost:3100/admin/api",
      "agents",
      2000,
      mockFetch(200, body),
    );
    expect(result).toEqual(body);
  });

  test("returns undefined on non-200", async () => {
    const result = await fetchAdminJson(
      "http://localhost:3100/admin/api",
      "agents",
      2000,
      mockFetch(404),
    );
    expect(result).toBeUndefined();
  });

  test("returns undefined on network error", async () => {
    const result = await fetchAdminJson(
      "http://localhost:3100/admin/api",
      "agents",
      2000,
      mockFetchError(),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveNexusMode
// ---------------------------------------------------------------------------

describe("resolveNexusMode", () => {
  test("demo -> embed-auth", () => {
    expect(resolveNexusMode("demo")).toBe("embed-auth");
  });

  test("mesh -> embed-auth", () => {
    expect(resolveNexusMode("mesh")).toBe("embed-auth");
  });

  test("local -> embed-lite", () => {
    expect(resolveNexusMode("local")).toBe("embed-lite");
  });

  test("undefined -> undefined", () => {
    expect(resolveNexusMode(undefined)).toBeUndefined();
  });

  test("infers embed-auth from demo.pack (legacy fallback)", () => {
    expect(resolveNexusMode(undefined, { pack: "finance" })).toBe("embed-auth");
  });

  test("demo.pack without string value does not infer", () => {
    expect(resolveNexusMode(undefined, { pack: 123 })).toBeUndefined();
    expect(resolveNexusMode(undefined, {})).toBeUndefined();
  });
});
