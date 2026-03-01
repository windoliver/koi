import { describe, expect, test } from "bun:test";
import { createNexusPayLedger } from "./ledger.js";

// ---------------------------------------------------------------------------
// Mock fetch factory
// ---------------------------------------------------------------------------

function createMockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(body !== undefined ? JSON.stringify(body) : "", {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

function createNetworkErrorFetch(): typeof globalThis.fetch {
  return (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
}

function createInvalidJsonFetch(): typeof globalThis.fetch {
  return (async () => {
    return new Response("not json{{{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

const BASE_CONFIG = {
  baseUrl: "https://pay.example.com",
  apiKey: "sk-test-123",
  timeout: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

describe("createNexusPayLedger", () => {
  describe("getBalance", () => {
    test("returns PayBalance on success", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, {
          available: "100.50",
          reserved: "10.00",
          total: "110.50",
        }),
      });
      const balance = await ledger.getBalance();
      expect(balance).toEqual({
        available: "100.50",
        reserved: "10.00",
        total: "110.50",
      });
    });
  });

  describe("canAfford", () => {
    test("returns true when affordable", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { can_afford: true, amount: "5.00" }),
      });
      const result = await ledger.canAfford("5.00");
      expect(result).toEqual({ canAfford: true, amount: "5.00" });
    });

    test("returns false when not affordable", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { can_afford: false, amount: "999.00" }),
      });
      const result = await ledger.canAfford("999.00");
      expect(result).toEqual({ canAfford: false, amount: "999.00" });
    });
  });

  describe("transfer", () => {
    test("returns PayReceipt on success", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, {
          id: "txn-001",
          method: "transfer",
          amount: "25.00",
          from_agent: "agent-a",
          to_agent: "agent-b",
          memo: "payment for work",
          timestamp: "2026-01-15T10:00:00Z",
        }),
      });
      const receipt = await ledger.transfer("agent-b", "25.00", "payment for work");
      expect(receipt).toEqual({
        id: "txn-001",
        method: "transfer",
        amount: "25.00",
        fromAgent: "agent-a",
        toAgent: "agent-b",
        memo: "payment for work",
        timestamp: "2026-01-15T10:00:00Z",
      });
    });
  });

  describe("reserve", () => {
    test("returns PayReservation on success", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, {
          id: "rsv-001",
          amount: "50.00",
          purpose: "model call",
          expires_at: "2026-01-15T11:00:00Z",
          status: "pending",
        }),
      });
      const reservation = await ledger.reserve("50.00", 3600, "model call");
      expect(reservation).toEqual({
        id: "rsv-001",
        amount: "50.00",
        purpose: "model call",
        expiresAt: "2026-01-15T11:00:00Z",
        status: "pending",
      });
    });
  });

  describe("commit", () => {
    test("succeeds with no return value", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(204, undefined),
      });
      await expect(ledger.commit("rsv-001")).resolves.toBeUndefined();
    });

    test("succeeds with actualAmount", async () => {
      const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
        expect(body.actual_amount).toBe("42.50");
        return new Response("", { status: 204 });
      }) as unknown as typeof globalThis.fetch;

      const ledger = createNexusPayLedger({ ...BASE_CONFIG, fetch: mockFetch });
      await expect(ledger.commit("rsv-001", "42.50")).resolves.toBeUndefined();
    });
  });

  describe("release", () => {
    test("succeeds with no return value", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(204, undefined),
      });
      await expect(ledger.release("rsv-001")).resolves.toBeUndefined();
    });
  });

  describe("meter", () => {
    test("returns PayMeterResult on success", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(200, { success: true }),
      });
      const result = await ledger.meter("0.05", "model_call");
      expect(result).toEqual({ success: true });
    });

    test("throws on insufficient credits (402)", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(402, { message: "Insufficient credits" }),
      });
      try {
        await ledger.meter("999.00");
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        const cause = err.cause as { readonly code: string };
        expect(cause.code).toBe("RATE_LIMIT");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // HTTP error mapping
  // ---------------------------------------------------------------------------

  describe("HTTP error mapping", () => {
    test("401 maps to PERMISSION", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(401, { message: "Unauthorized" }),
      });
      try {
        await ledger.getBalance();
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        const cause = err.cause as { readonly code: string };
        expect(cause.code).toBe("PERMISSION");
      }
    });

    test("402 maps to RATE_LIMIT", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(402, { message: "Payment required" }),
      });
      try {
        await ledger.getBalance();
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        const cause = err.cause as { readonly code: string };
        expect(cause.code).toBe("RATE_LIMIT");
      }
    });

    test("403 maps to PERMISSION", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(403, { message: "Forbidden" }),
      });
      try {
        await ledger.getBalance();
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        const cause = err.cause as { readonly code: string };
        expect(cause.code).toBe("PERMISSION");
      }
    });

    test("404 maps to NOT_FOUND", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(404, { message: "Not found" }),
      });
      try {
        await ledger.getBalance();
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        const cause = err.cause as { readonly code: string };
        expect(cause.code).toBe("NOT_FOUND");
      }
    });

    test("409 maps to CONFLICT", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(409, { message: "Reservation conflict" }),
      });
      try {
        await ledger.reserve("10.00");
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        const cause = err.cause as { readonly code: string };
        expect(cause.code).toBe("CONFLICT");
      }
    });

    test("429 maps to RATE_LIMIT", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(429, { message: "Too many requests" }),
      });
      try {
        await ledger.getBalance();
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        const cause = err.cause as { readonly code: string };
        expect(cause.code).toBe("RATE_LIMIT");
      }
    });

    test("500 maps to EXTERNAL (retryable)", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(500, { message: "Internal server error" }),
      });
      try {
        await ledger.getBalance();
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        const cause = err.cause as { readonly code: string; readonly retryable: boolean };
        expect(cause.code).toBe("EXTERNAL");
        expect(cause.retryable).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    test("network failure throws with cause", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createNetworkErrorFetch(),
      });
      try {
        await ledger.getBalance();
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        expect(err.message).toContain("Nexus pay request failed");
        expect(err.cause).toBeInstanceOf(TypeError);
      }
    });

    test("invalid JSON response throws with cause", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createInvalidJsonFetch(),
      });
      try {
        await ledger.getBalance();
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        const err = e as Error;
        expect(err.message).toContain("Failed to parse");
      }
    });

    test("empty response body handled for 204", async () => {
      const ledger = createNexusPayLedger({
        ...BASE_CONFIG,
        fetch: createMockFetch(204, undefined),
      });
      // commit returns void — should not throw on empty body
      await expect(ledger.commit("rsv-001")).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Request format verification
  // ---------------------------------------------------------------------------

  describe("request format", () => {
    test("sends Authorization header", async () => {
      let capturedHeaders: Record<string, string> = {};
      const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
        return new Response(JSON.stringify({ available: "0", reserved: "0", total: "0" }), {
          status: 200,
        });
      }) as unknown as typeof globalThis.fetch;

      const ledger = createNexusPayLedger({ ...BASE_CONFIG, fetch: mockFetch });
      await ledger.getBalance();
      expect(capturedHeaders.Authorization).toBe("Bearer sk-test-123");
    });

    test("sends correct URL for canAfford", async () => {
      let capturedUrl = "";
      const mockFetch = (async (url: string | URL | Request) => {
        capturedUrl = url as string;
        return new Response(JSON.stringify({ can_afford: true, amount: "5.00" }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const ledger = createNexusPayLedger({ ...BASE_CONFIG, fetch: mockFetch });
      await ledger.canAfford("5.00");
      expect(capturedUrl).toBe("https://pay.example.com/api/v2/pay/can-afford?amount=5.00");
    });
  });
});
