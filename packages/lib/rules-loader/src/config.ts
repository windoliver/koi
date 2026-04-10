/**
 * @koi/rules-loader — Configuration types, defaults, and validation.
 */

import type { KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

export interface RulesLoaderConfig {
  /** Recognized rules filenames to scan for. Default: ["CLAUDE.md", "AGENTS.md", "context.md"] */
  readonly filenames?: readonly string[] | undefined;
  /** Subdirectories to check at each level. Default: [".", ".koi"] */
  readonly searchDirs?: readonly string[] | undefined;
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
  readonly filenames: readonly string[];
  readonly searchDirs: readonly string[];
  readonly maxTokens: number;
  readonly getCwd: () => string;
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_FILENAMES: readonly string[] = ["CLAUDE.md", "AGENTS.md", "context.md"];
export const DEFAULT_SEARCH_DIRS: readonly string[] = [".", ".koi"];
export const DEFAULT_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A discovered rules file with its path and depth from root. */
export interface DiscoveredFile {
  readonly path: string;
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
    filenames: config?.filenames ?? DEFAULT_FILENAMES,
    searchDirs: config?.searchDirs ?? DEFAULT_SEARCH_DIRS,
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

  if (config?.filenames !== undefined && config.filenames.length === 0) {
    const error: KoiError = {
      code: "VALIDATION",
      message: "filenames must not be empty",
      retryable: false,
    };
    return { ok: false, error };
  }

  return { ok: true, value: resolveConfig(config) };
}
