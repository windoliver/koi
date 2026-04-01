/**
 * Sandbox admin types — contract for listing and garbage-collecting persistent sandboxes.
 *
 * Implementation is deferred; this module defines the interface only.
 */

import type { SandboxInstanceState } from "@koi/core";

/** Metadata for a persistent sandbox instance. */
export interface PersistentSandboxInfo {
  /** Scope key used for findOrCreate. */
  readonly scope: string;
  /** Name of the adapter that owns this sandbox (e.g., "docker", "e2b"). */
  readonly adapterName: string;
  /** ISO 8601 timestamp of initial creation. */
  readonly createdAt: string;
  /** ISO 8601 timestamp of last use (last exec/warmup). */
  readonly lastUsedAt: string;
  /** Platform-specific instance ID (container ID, sandbox ID, etc.). */
  readonly platformId: string;
  /** Current lifecycle state. */
  readonly state: SandboxInstanceState;
}

/** Admin interface for managing persistent sandboxes. */
export interface SandboxAdmin {
  /** List all persistent sandboxes known to this adapter. */
  readonly list: () => Promise<readonly PersistentSandboxInfo[]>;
  /** Garbage-collect sandboxes older than maxAgeMs. Returns count of destroyed sandboxes. */
  readonly gc: (maxAgeMs: number) => Promise<number>;
}
