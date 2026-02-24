/**
 * Soul middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

/** Manifest-level soul/user config: string path/inline or object with path + maxTokens. */
export type SoulUserInput = string | { readonly path: string; readonly maxTokens?: number };

/** Options for creating the soul middleware. */
export interface CreateSoulOptions {
  readonly soul?: SoulUserInput | undefined;
  readonly user?: SoulUserInput | undefined;
  readonly basePath: string;
  readonly refreshUser?: boolean | undefined;
}

/** Default token budgets. */
export const DEFAULT_SOUL_MAX_TOKENS = 4000;
export const DEFAULT_USER_MAX_TOKENS = 2000;

/** Extracts the raw input string from a soul/user config value. */
export function extractInput(value: SoulUserInput): string {
  return typeof value === "string" ? value : value.path;
}

/** Extracts the maxTokens from a soul/user config value, falling back to the default. */
export function extractMaxTokens(value: SoulUserInput, defaultTokens: number): number {
  if (typeof value === "string") return defaultTokens;
  return value.maxTokens ?? defaultTokens;
}

/** Validates the CreateSoulOptions, returning a Result. */
export function validateSoulConfig(config: unknown): Result<CreateSoulOptions, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  if (typeof c.basePath !== "string" || c.basePath.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a non-empty 'basePath' string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.soul !== undefined) {
    if (typeof c.soul !== "string" && (typeof c.soul !== "object" || c.soul === null)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "soul must be a string or { path: string, maxTokens?: number }",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    if (typeof c.soul === "object") {
      const s = c.soul as Record<string, unknown>;
      if (typeof s.path !== "string") {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "soul.path must be a string",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
      if (s.maxTokens !== undefined && (typeof s.maxTokens !== "number" || s.maxTokens <= 0)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "soul.maxTokens must be a positive number",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
  }

  if (c.user !== undefined) {
    if (typeof c.user !== "string" && (typeof c.user !== "object" || c.user === null)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "user must be a string or { path: string, maxTokens?: number }",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
    if (typeof c.user === "object") {
      const u = c.user as Record<string, unknown>;
      if (typeof u.path !== "string") {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "user.path must be a string",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
      if (u.maxTokens !== undefined && (typeof u.maxTokens !== "number" || u.maxTokens <= 0)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "user.maxTokens must be a positive number",
            retryable: RETRYABLE_DEFAULTS.VALIDATION,
          },
        };
      }
    }
  }

  if (c.refreshUser !== undefined && typeof c.refreshUser !== "boolean") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "refreshUser must be a boolean",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: config as CreateSoulOptions };
}
