/**
 * @koi/rules-loader — Configuration types, defaults, and validation.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

/**
 * An explicit scan entry: relative path to check at each directory level.
 * Example: "CLAUDE.md" checks `<dir>/CLAUDE.md`, ".koi/context.md" checks `<dir>/.koi/context.md`.
 */
export type ScanPath = string;

export interface RulesLoaderConfig {
  /**
   * Explicit relative paths to scan at each directory level.
   * Default: ["CLAUDE.md", "AGENTS.md", ".koi/CLAUDE.md", ".koi/AGENTS.md", ".koi/context.md"]
   */
  readonly scanPaths?: readonly ScanPath[] | undefined;
  /** Maximum token budget for merged rules content. Default: 8000 */
  readonly maxTokens?: number | undefined;
  /**
   * Working directory to start discovery from.
   * Can be a string (fixed) or a function (dynamic, called each turn).
   * Default: process.cwd()
   */
  readonly cwd?: string | (() => string) | undefined;
  /** Set to false to disable rules loading entirely. Default: true */
  readonly enabled?: boolean | undefined;
}

export interface ResolvedConfig {
  readonly scanPaths: readonly ScanPath[];
  readonly maxTokens: number;
  readonly getCwd: () => string;
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default scan paths. Each entry is a relative path checked at every
 * directory level from cwd up to git root.
 *
 * `context.md` is only checked inside `.koi/` — bare `context.md` in
 * a project root is not trusted to prevent accidental injection of
 * arbitrary project docs.
 */
export const DEFAULT_SCAN_PATHS: readonly ScanPath[] = [
  "CLAUDE.md",
  "AGENTS.md",
  ".koi/CLAUDE.md",
  ".koi/AGENTS.md",
  ".koi/context.md",
];
export const DEFAULT_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A discovered rules file with its path and depth from root. */
export interface DiscoveredFile {
  /** Original path (for display/caching). */
  readonly path: string;
  /** Canonical resolved path (for reading — immune to symlink swaps). */
  readonly realPath: string;
  /** 0 = git root (or filesystem root), higher = deeper toward cwd. */
  readonly depth: number;
}

/** A loaded rules file with content and token estimate. */
export interface LoadedFile {
  readonly path: string;
  readonly depth: number;
  readonly content: string;
  readonly estimatedTokens: number;
  /** File mtime at load time, for cache invalidation. */
  readonly mtimeMs: number;
}

/** The final merged ruleset ready for injection. */
export interface MergedRuleset {
  readonly content: string;
  readonly files: readonly string[];
  readonly estimatedTokens: number;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function resolveConfig(config?: RulesLoaderConfig): ResolvedConfig {
  const cwdOption = config?.cwd;
  const getCwd: () => string =
    cwdOption === undefined
      ? () => process.cwd()
      : typeof cwdOption === "function"
        ? cwdOption
        : () => cwdOption;

  return {
    scanPaths: config?.scanPaths ?? DEFAULT_SCAN_PATHS,
    maxTokens: config?.maxTokens ?? DEFAULT_MAX_TOKENS,
    getCwd,
    enabled: config?.enabled ?? true,
  };
}

export function validateRulesLoaderConfig(config?: RulesLoaderConfig): Result<ResolvedConfig> {
  if (config?.maxTokens !== undefined && config.maxTokens <= 0) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `maxTokens must be positive, got ${String(config.maxTokens)}`,
      retryable: false,
    };
    return { ok: false, error };
  }

  if (config?.scanPaths !== undefined && config.scanPaths.length === 0) {
    const error: KoiError = {
      code: "VALIDATION",
      message: "scanPaths must not be empty",
      retryable: false,
    };
    return { ok: false, error };
  }

  return { ok: true, value: resolveConfig(config) };
}
