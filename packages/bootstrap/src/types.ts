/**
 * Types for the bootstrap file hierarchy resolver.
 *
 * Resolves .koi/{INSTRUCTIONS,TOOLS,CONTEXT}.md files per agent type
 * and outputs text sources for the context hydrator.
 */

import type { KoiError, Result } from "@koi/core";

/** A single file slot in the bootstrap hierarchy. */
export interface BootstrapSlot {
  readonly fileName: string;
  readonly label: string;
  readonly budget: number;
}

/** Configuration for resolveBootstrap(). */
export interface BootstrapConfig {
  readonly rootDir: string;
  readonly agentName?: string | undefined;
  readonly slots?: readonly BootstrapSlot[] | undefined;
}

/** A plain text source compatible with @koi/context TextSource shape. */
export interface BootstrapTextSource {
  readonly kind: "text";
  readonly text: string;
  readonly label: string;
  readonly priority: number;
}

/** Metadata about a single resolved file. */
export interface ResolvedSlot {
  readonly fileName: string;
  readonly label: string;
  readonly content: string;
  readonly contentHash: number;
  readonly resolvedFrom: string;
  readonly truncated: boolean;
  readonly originalSize: number;
}

/** Result of the full bootstrap resolution. */
export interface BootstrapResult {
  readonly sources: readonly BootstrapTextSource[];
  readonly resolved: readonly ResolvedSlot[];
  readonly warnings: readonly string[];
}

export type BootstrapResolveResult = Result<BootstrapResult, KoiError>;
