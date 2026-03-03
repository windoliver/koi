/**
 * PayLedger contract — persistent credit ledger interface.
 *
 * Defines the L0 contract for credit-based budget enforcement.
 * L2 implementations (e.g., @koi/pay-nexus) talk to a backend
 * (TigerBeetle + PostgreSQL via Nexus pay API).
 *
 * All amounts are decimal strings (e.g., "100.50") to avoid
 * floating-point precision issues at the interface boundary.
 * Implementations may use integer micro-units internally.
 */

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface PayBalance {
  readonly available: string;
  readonly reserved: string;
  readonly total: string;
}

export interface PayReceipt {
  readonly id: string;
  readonly method: string;
  readonly amount: string;
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly memo: string | null;
  readonly timestamp: string | null;
}

export interface PayReservation {
  readonly id: string;
  readonly amount: string;
  readonly purpose: string;
  readonly expiresAt: string | null;
  readonly status: string;
}

export interface PayMeterResult {
  readonly success: boolean;
}

export interface PayCanAffordResult {
  readonly canAfford: boolean;
  readonly amount: string;
}

// ---------------------------------------------------------------------------
// PayLedger — main contract
// ---------------------------------------------------------------------------

export interface PayLedger {
  /** Get current balance (available, reserved, total). */
  readonly getBalance: () => PayBalance | Promise<PayBalance>;

  /** Check whether the account can afford a given amount. */
  readonly canAfford: (amount: string) => PayCanAffordResult | Promise<PayCanAffordResult>;

  /** Transfer credits to another agent. */
  readonly transfer: (
    to: string,
    amount: string,
    memo?: string,
  ) => PayReceipt | Promise<PayReceipt>;

  /** Reserve credits for future use. */
  readonly reserve: (
    amount: string,
    timeoutSeconds?: number,
    purpose?: string,
  ) => PayReservation | Promise<PayReservation>;

  /** Commit a reservation (optionally with adjusted amount). */
  readonly commit: (reservationId: string, actualAmount?: string) => void | Promise<void>;

  /** Release a reservation, returning credits to available balance. */
  readonly release: (reservationId: string) => void | Promise<void>;

  /** Record a metered usage event. */
  readonly meter: (amount: string, eventType?: string) => PayMeterResult | Promise<PayMeterResult>;
}
