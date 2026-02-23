/**
 * Sandbox executor contract — injected dependency for code execution in isolation.
 *
 * Used by @koi/forge (verification pipeline) and @koi/sandbox-ipc (IPC bridge).
 * The executor runs arbitrary code in an OS-level sandbox and returns a typed result.
 *
 * Note: @koi/sandbox (L2) also defines a `SandboxResult` for OS process output
 * (exitCode, stdout, stderr). These are different types serving different purposes.
 * This module's `SandboxResult` represents the return value of executed code.
 */

// ---------------------------------------------------------------------------
// Error types for sandbox execution
// ---------------------------------------------------------------------------

export type SandboxErrorCode = "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH";

export interface SandboxError {
  readonly code: SandboxErrorCode;
  readonly message: string;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Result of executing code in a sandbox
// ---------------------------------------------------------------------------

export interface SandboxResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes?: number;
}

// ---------------------------------------------------------------------------
// Executor contract — the pluggable sandbox backend
// ---------------------------------------------------------------------------

export interface SandboxExecutor {
  readonly execute: (
    code: string,
    input: unknown,
    timeoutMs: number,
  ) => Promise<
    | { readonly ok: true; readonly value: SandboxResult }
    | { readonly ok: false; readonly error: SandboxError }
  >;
}

// ---------------------------------------------------------------------------
// Tiered execution — trust-tier-aware dispatch
// ---------------------------------------------------------------------------

import type { TrustTier } from "./ecs.js";

/**
 * Result of resolving a trust tier to a concrete executor.
 * Includes observability metadata: which tier was requested,
 * which tier actually resolved, and whether fallback was applied.
 */
export interface TierResolution {
  readonly executor: SandboxExecutor;
  readonly requestedTier: TrustTier;
  readonly resolvedTier: TrustTier;
  readonly fallback: boolean;
}

/**
 * Trust-tier-aware dispatcher — routes `execute()` calls to per-tier backends.
 * Used by @koi/forge to dispatch bricks to the correct execution environment.
 */
export interface TieredSandboxExecutor {
  readonly forTier: (tier: TrustTier) => TierResolution;
}
