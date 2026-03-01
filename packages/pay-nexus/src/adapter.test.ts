import { describe, expect, test } from "bun:test";
import type { PayLedger } from "@koi/core/pay-ledger";
import { createNexusBudgetTracker, mapPayLedgerToBudgetTracker } from "./adapter.js";

// ---------------------------------------------------------------------------
// Mock PayLedger factory
// ---------------------------------------------------------------------------

function createMockLedger(overrides?: Partial<PayLedger>): PayLedger {
  return {
    getBalance: async () => ({
      available: "75.00",
      reserved: "5.00",
      total: "80.00",
    }),
    canAfford: async (amount: string) => ({
      canAfford: parseFloat(amount) <= 75,
      amount,
    }),
    transfer: async () => ({
      id: "txn-mock",
      method: "transfer",
      amount: "0",
      fromAgent: "a",
      toAgent: "b",
      memo: null,
      timestamp: null,
    }),
    reserve: async () => ({
      id: "rsv-mock",
      amount: "0",
      purpose: "",
      expiresAt: null,
      status: "pending",
    }),
    commit: async () => undefined,
    release: async () => undefined,
    meter: async () => ({ success: true }),
    ...overrides,
  };
}

describe("mapPayLedgerToBudgetTracker", () => {
  test("record() calls ledger.meter()", async () => {
    let capturedAmount = "";
    let capturedEventType = "";
    const ledger = createMockLedger({
      meter: async (amount: string, eventType?: string) => {
        capturedAmount = amount;
        capturedEventType = eventType ?? "";
        return { success: true };
      },
    });
    const tracker = mapPayLedgerToBudgetTracker(ledger, 100);

    await tracker.record("session-1", {
      inputTokens: 100,
      outputTokens: 50,
      model: "test-model",
      costUsd: 0.05,
      timestamp: Date.now(),
    });
    expect(capturedAmount).toBe("0.05");
    expect(capturedEventType).toBe("model_call");
  });

  test("totalSpend() derives from getBalance()", async () => {
    const ledger = createMockLedger({
      getBalance: async () => ({
        available: "75.00",
        reserved: "5.00",
        total: "80.00",
      }),
    });
    const tracker = mapPayLedgerToBudgetTracker(ledger, 100);

    const spent = await tracker.totalSpend("session-1");
    // budget (100) - available (75) = 25
    expect(spent).toBe(25);
  });

  test("remaining() returns available balance", async () => {
    const ledger = createMockLedger({
      getBalance: async () => ({
        available: "42.50",
        reserved: "0",
        total: "42.50",
      }),
    });
    const tracker = mapPayLedgerToBudgetTracker(ledger, 100);

    const remaining = await tracker.remaining("session-1", 100);
    expect(remaining).toBe(42.5);
  });

  test("handles string-to-number conversion correctly", async () => {
    const ledger = createMockLedger({
      getBalance: async () => ({
        available: "10.50",
        reserved: "0",
        total: "10.50",
      }),
    });
    const tracker = mapPayLedgerToBudgetTracker(ledger, 50);

    const spent = await tracker.totalSpend("session-1");
    expect(spent).toBe(39.5);
    const remaining = await tracker.remaining("session-1", 50);
    expect(remaining).toBe(10.5);
  });

  test("zero balance returns zero remaining and full spend", async () => {
    const ledger = createMockLedger({
      getBalance: async () => ({
        available: "0",
        reserved: "0",
        total: "0",
      }),
    });
    const tracker = mapPayLedgerToBudgetTracker(ledger, 100);

    const spent = await tracker.totalSpend("session-1");
    expect(spent).toBe(100);
    const remaining = await tracker.remaining("session-1", 100);
    expect(remaining).toBe(0);
  });

  describe("breakdown()", () => {
    test("has breakdown method", () => {
      const ledger = createMockLedger();
      const tracker = mapPayLedgerToBudgetTracker(ledger, 100);
      expect(typeof tracker.breakdown).toBe("function");
    });

    test("returns totalCostUsd from balance", async () => {
      const ledger = createMockLedger({
        getBalance: async () => ({
          available: "60.00",
          reserved: "5.00",
          total: "65.00",
        }),
      });
      const tracker = mapPayLedgerToBudgetTracker(ledger, 100);
      const bd = await tracker.breakdown("session-1");
      // budget (100) - available (60) = 40
      expect(bd.totalCostUsd).toBe(40);
    });

    test("returns empty byModel and byTool arrays", async () => {
      const ledger = createMockLedger();
      const tracker = mapPayLedgerToBudgetTracker(ledger, 100);
      const bd = await tracker.breakdown("session-1");
      expect(bd.byModel).toEqual([]);
      expect(bd.byTool).toEqual([]);
    });
  });
});

describe("createNexusBudgetTracker", () => {
  test("creates a working BudgetTracker from config", () => {
    // Just verify it returns an object with the right shape
    const tracker = createNexusBudgetTracker({
      baseUrl: "https://pay.example.com",
      apiKey: "sk-test",
      budget: 100,
    });
    expect(typeof tracker.record).toBe("function");
    expect(typeof tracker.totalSpend).toBe("function");
    expect(typeof tracker.remaining).toBe("function");
    expect(typeof tracker.breakdown).toBe("function");
  });
});
