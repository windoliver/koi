/**
 * NexusPayLedger — Nexus-backed PayLedger implementation.
 *
 * Thin HTTP client that talks to the Nexus pay API (v2).
 * Follows the nexus-store.ts pattern: injectable fetch, AbortSignal timeout,
 * mapHttpError for consistent error codes.
 */

import type { KoiError } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type {
  PayBalance,
  PayCanAffordResult,
  PayLedger,
  PayMeterResult,
  PayReceipt,
  PayReservation,
} from "@koi/core/pay-ledger";
import type { NexusPayLedgerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Wire types (snake_case from API)
// ---------------------------------------------------------------------------

interface ApiBalance {
  readonly available: string;
  readonly reserved: string;
  readonly total: string;
}

interface ApiReceipt {
  readonly id: string;
  readonly method: string;
  readonly amount: string;
  readonly from_agent: string;
  readonly to_agent: string;
  readonly memo: string | null;
  readonly timestamp: string | null;
}

interface ApiReservation {
  readonly id: string;
  readonly amount: string;
  readonly purpose: string;
  readonly expires_at: string | null;
  readonly status: string;
}

interface ApiMeter {
  readonly success: boolean;
}

interface ApiCanAfford {
  readonly can_afford: boolean;
  readonly amount: string;
}

// ---------------------------------------------------------------------------
// Response mappers (snake_case → camelCase)
// ---------------------------------------------------------------------------

function mapBalance(raw: ApiBalance): PayBalance {
  return {
    available: raw.available,
    reserved: raw.reserved,
    total: raw.total,
  };
}

function mapReceipt(raw: ApiReceipt): PayReceipt {
  return {
    id: raw.id,
    method: raw.method,
    amount: raw.amount,
    fromAgent: raw.from_agent,
    toAgent: raw.to_agent,
    memo: raw.memo,
    timestamp: raw.timestamp,
  };
}

function mapReservation(raw: ApiReservation): PayReservation {
  return {
    id: raw.id,
    amount: raw.amount,
    purpose: raw.purpose,
    expiresAt: raw.expires_at,
    status: raw.status,
  };
}

function mapCanAfford(raw: ApiCanAfford): PayCanAffordResult {
  return {
    canAfford: raw.can_afford,
    amount: raw.amount,
  };
}

// ---------------------------------------------------------------------------
// HTTP error mapping
// ---------------------------------------------------------------------------

function mapHttpError(status: number, message: string): KoiError {
  if (status === 401) {
    return { code: "PERMISSION", message, retryable: RETRYABLE_DEFAULTS.PERMISSION };
  }
  if (status === 402) {
    return {
      code: "RATE_LIMIT",
      message: message || "Insufficient credits",
      retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
    };
  }
  if (status === 403) {
    return {
      code: "PERMISSION",
      message: message || "Budget exceeded",
      retryable: RETRYABLE_DEFAULTS.PERMISSION,
    };
  }
  if (status === 404) {
    return { code: "NOT_FOUND", message, retryable: RETRYABLE_DEFAULTS.NOT_FOUND };
  }
  if (status === 409) {
    return { code: "CONFLICT", message: message || "Reservation conflict", retryable: false };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMIT",
      message: message || "Rate limited",
      retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
    };
  }
  if (status >= 500) {
    return { code: "EXTERNAL", message, retryable: true };
  }
  return { code: "EXTERNAL", message: message || `HTTP ${status}`, retryable: false };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 10_000;

export function createNexusPayLedger(config: NexusPayLedgerConfig): PayLedger {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeout = config.timeout ?? DEFAULT_TIMEOUT;
  const base = config.baseUrl.replace(/\/$/, "");

  async function request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };

    // let: assigned inside try/catch
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e: unknown) {
      throw new Error(`Nexus pay request failed: ${method} ${path}`, { cause: e });
    }

    if (!response.ok) {
      // let: conditionally updated from error body JSON
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorBody = (await response.json()) as { readonly message?: string };
        if (errorBody.message) {
          errorMessage = errorBody.message;
        }
      } catch (_parseError: unknown) {
        // Error body is not JSON; fall through to use HTTP status code message
      }
      const koiError = mapHttpError(response.status, errorMessage);
      throw new Error(errorMessage, { cause: koiError });
    }

    // Handle empty responses (204 No Content, or empty body)
    const text = await response.text();
    if (text === "") {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (e: unknown) {
      throw new Error(`Failed to parse Nexus pay response: ${method} ${path}`, { cause: e });
    }
  }

  return {
    async getBalance(): Promise<PayBalance> {
      const raw = await request<ApiBalance>("GET", "/api/v2/pay/balance");
      return mapBalance(raw);
    },

    async canAfford(amount: string): Promise<PayCanAffordResult> {
      const encoded = encodeURIComponent(amount);
      const raw = await request<ApiCanAfford>("GET", `/api/v2/pay/can-afford?amount=${encoded}`);
      return mapCanAfford(raw);
    },

    async transfer(to: string, amount: string, memo?: string): Promise<PayReceipt> {
      const raw = await request<ApiReceipt>("POST", "/api/v2/pay/transfer", {
        to,
        amount,
        ...(memo !== undefined ? { memo } : {}),
      });
      return mapReceipt(raw);
    },

    async reserve(
      amount: string,
      timeoutSeconds?: number,
      purpose?: string,
    ): Promise<PayReservation> {
      const raw = await request<ApiReservation>("POST", "/api/v2/pay/reserve", {
        amount,
        ...(timeoutSeconds !== undefined ? { timeout_seconds: timeoutSeconds } : {}),
        ...(purpose !== undefined ? { purpose } : {}),
      });
      return mapReservation(raw);
    },

    async commit(reservationId: string, actualAmount?: string): Promise<void> {
      await request<undefined>(
        "POST",
        `/api/v2/pay/reserve/${encodeURIComponent(reservationId)}/commit`,
        actualAmount !== undefined ? { actual_amount: actualAmount } : undefined,
      );
    },

    async release(reservationId: string): Promise<void> {
      await request<undefined>(
        "POST",
        `/api/v2/pay/reserve/${encodeURIComponent(reservationId)}/release`,
      );
    },

    async meter(amount: string, eventType?: string): Promise<PayMeterResult> {
      const raw = await request<ApiMeter>("POST", "/api/v2/pay/meter", {
        amount,
        ...(eventType !== undefined ? { event_type: eventType } : {}),
      });
      return { success: raw.success };
    },
  };
}
