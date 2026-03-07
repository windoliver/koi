/**
 * Local PayLedger implementation — append-only ledger with cached derived balance.
 *
 * Supports optional SQLite persistence via @koi/sqlite-utils.
 * All amounts are decimal strings at the interface boundary, converted to
 * floating-point internally for arithmetic.
 */

import type { Database } from "bun:sqlite";
import type {
  PayBalance,
  PayCanAffordResult,
  PayLedger,
  PayMeterResult,
  PayReceipt,
  PayReservation,
} from "@koi/core/pay-ledger";
import { openDb } from "@koi/sqlite-utils";
import { initSchema, insertEntry } from "./schema.js";
import type { LocalPayLedgerConfig, ReservationState } from "./types.js";

const DEFAULT_RESERVATION_TIMEOUT_S = 300;

/** Generate a unique ID using crypto.randomUUID. */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Create a fully-functional local PayLedger.
 *
 * All 7 PayLedger methods are implemented (no throwing stubs).
 * Optionally persists to SQLite when `config.dbPath` is provided.
 */
export function createLocalPayLedger(config: LocalPayLedgerConfig): PayLedger & {
  /** Close the ledger, clearing timers and (if applicable) the database. */
  readonly close: () => void;
} {
  const initialBudget = parseFloat(config.initialBudget);
  if (!Number.isFinite(initialBudget) || initialBudget < 0) {
    throw new Error(
      `createLocalPayLedger: initialBudget must be a non-negative finite number string, got "${config.initialBudget}"`,
    );
  }

  // Optional SQLite persistence
  // let justified: db is lazily initialized and may be null
  let db: Database | null = null;
  if (config.dbPath !== undefined) {
    db = openDb(config.dbPath);
    initSchema(db);
  }

  // Mutable internal state — never exposed
  // let justified: running balance changes on every operation
  let available = initialBudget;
  // let justified: reserved amount changes on reserve/commit/release
  let reserved = 0;
  const reservations = new Map<string, ReservationState>();

  function appendEntry(
    kind: string,
    amount: number,
    reservationId: string | null,
    counterparty: string | null,
    memo: string | null,
  ): string {
    const id = generateId();
    const entry = {
      id,
      kind,
      amount: amount.toString(),
      balanceAfter: available.toString(),
      reservationId,
      counterparty,
      memo,
      timestamp: new Date().toISOString(),
    };
    if (db !== null) {
      insertEntry(db, entry);
    }
    return id;
  }

  function clearReservationTimer(state: ReservationState): void {
    if (state.timerId !== null) {
      clearTimeout(state.timerId);
    }
  }

  function expireReservation(reservationId: string): void {
    const state = reservations.get(reservationId);
    if (state === undefined) return;
    // Release credits back to available
    available += state.amount;
    reserved -= state.amount;
    reservations.delete(reservationId);
    appendEntry("release", state.amount, reservationId, null, "reservation expired");
  }

  return {
    getBalance(): PayBalance {
      return {
        available: available.toString(),
        reserved: reserved.toString(),
        total: (available + reserved).toString(),
      };
    },

    canAfford(amount: string): PayCanAffordResult {
      const numAmount = parseFloat(amount);
      return {
        canAfford: available >= numAmount,
        amount,
      };
    },

    transfer(to: string, amount: string, memo?: string): PayReceipt {
      const numAmount = parseFloat(amount);
      if (numAmount <= 0 || !Number.isFinite(numAmount)) {
        throw new Error(`transfer: amount must be positive, got "${amount}"`);
      }
      if (available < numAmount) {
        throw new Error(
          `transfer: insufficient balance (available: ${available}, requested: ${numAmount})`,
        );
      }

      available -= numAmount;
      const id = appendEntry("transfer", numAmount, null, to, memo ?? null);

      return {
        id,
        method: "local-ledger",
        amount,
        fromAgent: config.agentId,
        toAgent: to,
        memo: memo ?? null,
        timestamp: new Date().toISOString(),
      };
    },

    reserve(amount: string, timeoutSeconds?: number, purpose?: string): PayReservation {
      const numAmount = parseFloat(amount);
      if (numAmount <= 0 || !Number.isFinite(numAmount)) {
        throw new Error(`reserve: amount must be positive, got "${amount}"`);
      }
      if (available < numAmount) {
        throw new Error(
          `reserve: insufficient balance (available: ${available}, requested: ${numAmount})`,
        );
      }

      const timeout = timeoutSeconds ?? DEFAULT_RESERVATION_TIMEOUT_S;
      const expiresAt = Date.now() + timeout * 1000;
      const id = generateId();

      available -= numAmount;
      reserved += numAmount;

      const timerId = setTimeout(() => {
        expireReservation(id);
      }, timeout * 1000);
      // Prevent timer from keeping the process alive
      if (typeof timerId === "object" && "unref" in timerId) {
        timerId.unref();
      }

      const state: ReservationState = {
        id,
        amount: numAmount,
        purpose: purpose ?? "",
        expiresAt,
        timerId,
      };
      reservations.set(id, state);

      appendEntry("reserve", numAmount, id, null, purpose ?? null);

      return {
        id,
        amount,
        purpose: purpose ?? "",
        expiresAt: new Date(expiresAt).toISOString(),
        status: "active",
      };
    },

    commit(reservationId: string, actualAmount?: string): void {
      const state = reservations.get(reservationId);
      if (state === undefined) {
        throw new Error(`commit: unknown reservation "${reservationId}"`);
      }

      clearReservationTimer(state);
      reservations.delete(reservationId);

      const committed = actualAmount !== undefined ? parseFloat(actualAmount) : state.amount;
      if (!Number.isFinite(committed) || committed < 0) {
        throw new Error(
          `commit: actualAmount must be a non-negative finite number, got "${String(actualAmount)}"`,
        );
      }
      if (committed > state.amount) {
        throw new Error(
          `commit: actualAmount (${String(committed)}) exceeds reservation amount (${String(state.amount)})`,
        );
      }
      const returned = state.amount - committed;

      reserved -= state.amount;
      if (returned > 0) {
        available += returned;
      }

      appendEntry("commit", committed, reservationId, null, null);
    },

    release(reservationId: string): void {
      const state = reservations.get(reservationId);
      if (state === undefined) {
        throw new Error(`release: unknown reservation "${reservationId}"`);
      }

      clearReservationTimer(state);
      reservations.delete(reservationId);

      available += state.amount;
      reserved -= state.amount;

      appendEntry("release", state.amount, reservationId, null, null);
    },

    meter(amount: string, _eventType?: string): PayMeterResult {
      const numAmount = parseFloat(amount);
      if (!Number.isFinite(numAmount) || numAmount < 0) {
        throw new Error(`meter: amount must be a non-negative finite number, got "${amount}"`);
      }
      available -= numAmount;
      appendEntry("meter", numAmount, null, null, _eventType ?? null);
      return { success: true };
    },

    close(): void {
      // Clear all reservation timers
      for (const state of reservations.values()) {
        clearReservationTimer(state);
      }
      reservations.clear();
      if (db !== null) {
        db.close();
        db = null;
      }
    },
  };
}
