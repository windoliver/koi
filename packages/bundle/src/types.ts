/**
 * Config and result types for bundle export/import operations.
 */

import type { AgentBundle, ForgeStore } from "@koi/core";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Configuration for creating an agent bundle. */
export interface ExportBundleConfig {
  readonly name: string;
  readonly description: string;
  readonly manifestYaml: string;
  readonly brickIds: readonly string[];
  readonly store: ForgeStore;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Configuration for importing an agent bundle into a store. */
export interface ImportBundleConfig {
  readonly bundle: AgentBundle;
  readonly store: ForgeStore;
}

/** Result of a bundle import operation. */
export interface ImportBundleResult {
  readonly imported: number;
  readonly skipped: number;
  readonly errors: readonly ImportBrickError[];
}

/** Details about a brick that failed to import. */
export interface ImportBrickError {
  readonly brickId: string;
  readonly reason: string;
}
