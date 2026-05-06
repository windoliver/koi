/**
 * Edge function adapter contract — package-local L2 contract for JS-only edge runtimes.
 *
 * Distinct from `SandboxAdapter` (which is a process/`exec`-shaped contract).
 * Cloudflare Workers and Vercel Edge Functions execute JavaScript with no
 * argv/exit-code/shell model, so they implement THIS contract instead.
 *
 * v1 admits ONLY `workloadClass: "A"` (side-effect-free handlers). The dedupe
 * store caches outputs for caller convenience; class-A re-execution under the
 * documented partial-failure paths is intrinsically harmless.
 *
 * See `docs/superpowers/specs/2026-05-05-edge-sandboxes-design.md` for the
 * full normative contract.
 */

import type { KoiError, Result } from "./errors.js";
import type { SandboxProfile } from "./sandbox-profile.js";

/** Workload classification carried on adapter create config (NOT on `SandboxProfile`). */
export type EdgeWorkloadClass = "A";

/** Integrity verification mode for edge-adapter gateway attestation. */
export type EdgeIntegrityVerification = "cached" | "strict" | "async";

/**
 * Outcome of `EdgeFunctionInstance.destroy()`. Spec calls for "cancellation
 * honesty": destroy() reports whether the underlying provider artifact was
 * actually torn down, not just whether the local handle was released.
 */
export type EdgeDestroyOutcome = "destroyed" | "already-destroyed" | "detached-only";

/**
 * Inbound envelope for a single `invoke()` attempt against a deployed edge
 * function. `operationId` is the durable dedupe key; `requestId` is the
 * per-attempt nonce used only for shim-side dedupe.
 */
export interface EdgeInvokeRequest {
  readonly payload: unknown;
  /** Caller-owned, stable for the full logical operation, persists across destroy/recreate. */
  readonly operationId: string;
  /** UUIDv4 per network attempt. Used ONLY for shim-side per-isolate dedupe. */
  readonly requestId: string;
  /**
   * Caller-supplied retry-horizon expiry (Unix ms). After this timestamp,
   * retries of the same `operationId` are REJECTED with `OPERATION_EXPIRED`.
   * Hard cap: 30 days from the moment of first claim.
   */
  readonly dedupeExpiresAtMs: number;
  /**
   * Caller waiter budget. Default 30_000 ms; max 30_000 ms. NOT capped by
   * `profile.resources.timeoutMs` — waiter and handler budgets are distinct.
   */
  readonly waiterTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Successful response body from a deployed edge function. */
export interface EdgeInvokeResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly truncated?: boolean;
}

/** A deployed edge-function instance bound to one piece of operator code. */
export interface EdgeFunctionInstance {
  readonly invoke: (req: EdgeInvokeRequest) => Promise<Result<EdgeInvokeResult, KoiError>>;
  readonly destroy: () => Promise<Result<EdgeDestroyOutcome, KoiError>>;
}

/** Configuration accepted by `EdgeFunctionAdapter.create`. */
export interface EdgeFunctionCreateConfig {
  readonly code: string;
  readonly profile: SandboxProfile;
  /**
   * REQUIRED. Workload classification. v1 supports ONLY `"A"`; other values
   * are rejected at construction with `WORKLOAD_CLASS_NOT_SUPPORTED`.
   */
  readonly workloadClass: EdgeWorkloadClass;
}

/**
 * Backend that creates `EdgeFunctionInstance` deployments from operator code.
 * Each provider (Cloudflare, Vercel) is an independent L2 package.
 */
export interface EdgeFunctionAdapter {
  readonly name: string;
  readonly version: string;
  readonly create: (
    config: EdgeFunctionCreateConfig,
  ) => Promise<Result<EdgeFunctionInstance, KoiError>>;
}
