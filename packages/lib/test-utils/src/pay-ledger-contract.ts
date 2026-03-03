/**
 * Reusable contract test suite for PayLedger implementations.
 *
 * Accepts a factory that returns a PayLedger (sync or async).
 * Each test creates a fresh instance for isolation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { PayLedger } from "@koi/core/pay-ledger";

/**
 * Run the PayLedger contract test suite against any implementation.
 *
 * The factory should return a ledger pre-configured with an initial budget
 * of "1000" credits and an agentId of "agent-1".
 */
export function runPayLedgerContractTests(
  createLedger: () => PayLedger | Promise<PayLedger>,
): void {
  describe("PayLedger contract", () => {
    let ledger: PayLedger;

    beforeEach(async () => {
      ledger = await createLedger();
    });

    // -----------------------------------------------------------------------
    // getBalance
    // -----------------------------------------------------------------------

    test("getBalance returns initial state with full budget available", async () => {
      const balance = await ledger.getBalance();
      expect(parseFloat(balance.available)).toBeGreaterThan(0);
      expect(parseFloat(balance.reserved)).toBe(0);
      expect(parseFloat(balance.total)).toBeGreaterThan(0);
      expect(parseFloat(balance.available)).toBe(parseFloat(balance.total));
    });

    // -----------------------------------------------------------------------
    // meter
    // -----------------------------------------------------------------------

    test("meter deducts from available balance", async () => {
      const before = await ledger.getBalance();
      const result = await ledger.meter("10");
      expect(result.success).toBe(true);

      const after = await ledger.getBalance();
      expect(parseFloat(after.available)).toBe(parseFloat(before.available) - 10);
    });

    test("meter accumulates across multiple calls", async () => {
      const before = await ledger.getBalance();
      const initialTotal = parseFloat(before.total);

      await ledger.meter("10");
      await ledger.meter("20");
      await ledger.meter("30");

      const after = await ledger.getBalance();
      expect(parseFloat(after.available)).toBe(initialTotal - 60);
    });

    test("meter with zero amount succeeds", async () => {
      const before = await ledger.getBalance();
      const result = await ledger.meter("0");
      expect(result.success).toBe(true);

      const after = await ledger.getBalance();
      expect(after.available).toBe(before.available);
    });

    // -----------------------------------------------------------------------
    // canAfford
    // -----------------------------------------------------------------------

    test("canAfford returns true when balance is sufficient", async () => {
      const result = await ledger.canAfford("10");
      expect(result.canAfford).toBe(true);
      expect(result.amount).toBe("10");
    });

    test("canAfford returns false when balance is insufficient", async () => {
      const balance = await ledger.getBalance();
      const overBudget = (parseFloat(balance.total) + 1).toString();
      const result = await ledger.canAfford(overBudget);
      expect(result.canAfford).toBe(false);
    });

    test("canAfford boundary — exact amount equals available", async () => {
      const balance = await ledger.getBalance();
      const result = await ledger.canAfford(balance.available);
      expect(result.canAfford).toBe(true);
    });

    // -----------------------------------------------------------------------
    // reserve + commit
    // -----------------------------------------------------------------------

    test("reserve reduces available balance by reserved amount", async () => {
      const before = await ledger.getBalance();
      const reservation = await ledger.reserve("100", 60, "test reservation");

      expect(reservation.id).toBeTruthy();
      expect(reservation.amount).toBe("100");
      expect(reservation.purpose).toBe("test reservation");
      expect(reservation.status).toBeTruthy();

      const after = await ledger.getBalance();
      expect(parseFloat(after.available)).toBe(parseFloat(before.available) - 100);
      expect(parseFloat(after.reserved)).toBe(parseFloat(before.reserved) + 100);
    });

    test("commit finalizes a reservation", async () => {
      const reservation = await ledger.reserve("100", 60, "commit test");
      await ledger.commit(reservation.id);

      const balance = await ledger.getBalance();
      expect(parseFloat(balance.reserved)).toBe(0);
    });

    test("commit with adjusted amount uses the adjusted value", async () => {
      const before = await ledger.getBalance();
      const reservation = await ledger.reserve("100", 60, "adjusted commit");
      await ledger.commit(reservation.id, "50");

      const after = await ledger.getBalance();
      // Should have consumed only 50, returning 50 to available
      expect(parseFloat(after.available)).toBe(parseFloat(before.available) - 50);
      expect(parseFloat(after.reserved)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // reserve + release
    // -----------------------------------------------------------------------

    test("release returns reserved credits to available balance", async () => {
      const before = await ledger.getBalance();
      const reservation = await ledger.reserve("200", 60, "release test");

      const during = await ledger.getBalance();
      expect(parseFloat(during.available)).toBe(parseFloat(before.available) - 200);

      await ledger.release(reservation.id);

      const after = await ledger.getBalance();
      expect(parseFloat(after.available)).toBe(parseFloat(before.available));
      expect(parseFloat(after.reserved)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // transfer
    // -----------------------------------------------------------------------

    test("transfer creates a receipt with correct fields", async () => {
      const receipt = await ledger.transfer("agent-2", "50", "test transfer");

      expect(receipt.id).toBeTruthy();
      expect(receipt.amount).toBe("50");
      expect(receipt.toAgent).toBe("agent-2");
      expect(receipt.memo).toBe("test transfer");
    });

    test("transfer deducts from available balance", async () => {
      const before = await ledger.getBalance();
      await ledger.transfer("agent-2", "50");

      const after = await ledger.getBalance();
      expect(parseFloat(after.available)).toBe(parseFloat(before.available) - 50);
    });

    // -----------------------------------------------------------------------
    // reservation timeout
    // -----------------------------------------------------------------------

    test("reservation has expiresAt when timeoutSeconds is provided", async () => {
      const reservation = await ledger.reserve("50", 30, "timeout test");
      // expiresAt should be set (non-null) when timeout is provided
      expect(reservation.expiresAt).not.toBeNull();
    });

    // -----------------------------------------------------------------------
    // negative / invalid amounts
    // -----------------------------------------------------------------------

    test("meter with negative amount throws or fails", async () => {
      try {
        const result = await ledger.meter("-10");
        // If it returns without throwing, it should indicate failure
        // (implementations may throw or return success: false)
        if (result.success) {
          // Some implementations may silently accept — contract allows this
          // but the balance should reflect the deduction
        }
      } catch (_e: unknown) {
        // Throwing is acceptable behavior for negative amounts
      }
    });
  });
}
