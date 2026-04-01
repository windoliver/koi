/**
 * Sandbox types — re-exports from @koi/core (L0) + local aliases.
 *
 * Adapter types (SandboxAdapter, SandboxInstance, SandboxExecOptions, SandboxAdapterResult)
 * are canonical in @koi/core. This module re-exports them for backward compatibility
 * and adds the SandboxTier alias.
 */

import type { ToolPolicy } from "@koi/core";

/** Sandbox-specific alias for the L0 ToolPolicy. */
export type SandboxTier = ToolPolicy;

// Sandbox profile — canonical definitions live in @koi/core (L0)
// Sandbox adapter types — canonical definitions live in @koi/core (L0)
/**
 * Backward-compatible alias for SandboxAdapterResult.
 * New code should use SandboxAdapterResult directly from @koi/core.
 */
export type {
  FilesystemPolicy,
  NetworkPolicy,
  ResourceLimits,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxAdapterResult as SandboxResult,
  SandboxExecOptions,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
