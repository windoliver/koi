/**
 * Unified soul middleware configuration and validation.
 *
 * Merges configuration from @koi/middleware-soul and @koi/identity into
 * a single CreateSoulOptions with three composable layers:
 * - soul: global agent personality (supports file, inline, directory)
 * - identity: per-channel personas (name, avatar, instructions per channel)
 * - user: per-user context (supports file or inline)
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

/** Manifest-level soul/user config: string path/inline or object with path + maxTokens. */
export type ContentInput = string | { readonly path: string; readonly maxTokens?: number };

/**
 * Per-channel persona configuration.
 * `channelId` matches the exact package name of the active channel adapter
 * (e.g. "@koi/channel-telegram") as injected into `SessionContext.channelId` by L1.
 */
export interface ChannelPersonaConfig {
  /** Exact channelId to match (e.g. "@koi/channel-telegram"). */
  readonly channelId: string;
  /** Display name for this channel persona. */
  readonly name?: string;
  /** Avatar URL or path for this channel persona. */
  readonly avatar?: string;
  /** Inline instructions string or file path reference for this persona. */
  readonly instructions?: string | { readonly path: string; readonly maxTokens?: number };
}

/** Options for creating the unified soul middleware. */
export interface CreateSoulOptions {
  /** Global agent personality: file path, inline text, or directory. */
  readonly soul?: ContentInput | undefined;
  /** Per-channel identity personas. */
  readonly identity?: { readonly personas: readonly ChannelPersonaConfig[] } | undefined;
  /** Per-user context: file path or inline text. */
  readonly user?: ContentInput | undefined;
  /** Base path for resolving relative file paths. */
  readonly basePath: string;
  /** When true, user content is re-resolved on each model call. */
  readonly refreshUser?: boolean | undefined;
  /**
   * When true (default), injects meta-instructions telling the agent it can
   * modify its own personality via `fs_write` to the soul file.
   * Skipped automatically when soul content is inline (no file to modify).
   */
  readonly selfModify?: boolean | undefined;
}

/** Default token budgets. */
export const DEFAULT_SOUL_MAX_TOKENS = 4000;
export const DEFAULT_IDENTITY_MAX_TOKENS = 2000;
export const DEFAULT_USER_MAX_TOKENS = 2000;
export const DEFAULT_TOTAL_MAX_TOKENS = 8000;

/** Extracts the raw input string from a ContentInput value. */
export function extractInput(value: ContentInput): string {
  return typeof value === "string" ? value : value.path;
}

/** Extracts the maxTokens from a ContentInput value, falling back to the default. */
export function extractMaxTokens(value: ContentInput, defaultTokens: number): number {
  if (typeof value === "string") return defaultTokens;
  return value.maxTokens ?? defaultTokens;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type guard: narrows unknown to a string-keyed record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/** Type guard: narrows a validated value to ContentInput. */
function isContentInput(value: unknown): value is ContentInput {
  if (typeof value === "string") return true;
  return isRecord(value) && typeof value.path === "string";
}

/** Type guard: narrows a validated value to the identity config shape. */
function isIdentityConfig(
  value: unknown,
): value is { readonly personas: readonly ChannelPersonaConfig[] } {
  return isRecord(value) && Array.isArray(value.personas);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function validateContentInput(value: unknown, fieldName: string): KoiError | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return undefined;
  if (!isRecord(value)) {
    return {
      code: "VALIDATION",
      message: `${fieldName} must be a string or { path: string, maxTokens?: number }`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  if (typeof value.path !== "string") {
    return {
      code: "VALIDATION",
      message: `${fieldName}.path must be a string`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  if (
    value.maxTokens !== undefined &&
    (typeof value.maxTokens !== "number" || value.maxTokens <= 0)
  ) {
    return {
      code: "VALIDATION",
      message: `${fieldName}.maxTokens must be a positive number`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  return undefined;
}

/** Validates that a ChannelPersonaConfig entry is well-formed. */
function validatePersonaEntry(entry: unknown, index: number): KoiError | undefined {
  if (!isRecord(entry)) {
    return {
      code: "VALIDATION",
      message: `identity.personas[${index}] must be a non-null object`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  if (typeof entry.channelId !== "string" || entry.channelId.length === 0) {
    return {
      code: "VALIDATION",
      message: `identity.personas[${index}].channelId must be a non-empty string`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  if (entry.name !== undefined && typeof entry.name !== "string") {
    return {
      code: "VALIDATION",
      message: `identity.personas[${index}].name must be a string`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  if (entry.avatar !== undefined && typeof entry.avatar !== "string") {
    return {
      code: "VALIDATION",
      message: `identity.personas[${index}].avatar must be a string`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  if (entry.instructions !== undefined) {
    if (isRecord(entry.instructions)) {
      if (typeof entry.instructions.path !== "string") {
        return {
          code: "VALIDATION",
          message: `identity.personas[${index}].instructions.path must be a string`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        };
      }
      if (
        entry.instructions.maxTokens !== undefined &&
        (typeof entry.instructions.maxTokens !== "number" ||
          !Number.isFinite(entry.instructions.maxTokens) ||
          entry.instructions.maxTokens <= 0)
      ) {
        return {
          code: "VALIDATION",
          message: `identity.personas[${index}].instructions.maxTokens must be a positive number`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        };
      }
    } else if (typeof entry.instructions !== "string") {
      return {
        code: "VALIDATION",
        message: `identity.personas[${index}].instructions must be a string or { path: string }`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
  }
  return undefined;
}

/** Validates the unified CreateSoulOptions, returning a Result. */
export function validateSoulConfig(config: unknown): Result<CreateSoulOptions, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  const { basePath, soul, user, identity, refreshUser } = config;

  if (typeof basePath !== "string" || basePath.length === 0) {
    return validationError("Config requires a non-empty 'basePath' string");
  }

  // Validate soul
  const soulErr = validateContentInput(soul, "soul");
  if (soulErr !== undefined) return { ok: false, error: soulErr };

  // Validate user
  const userErr = validateContentInput(user, "user");
  if (userErr !== undefined) return { ok: false, error: userErr };

  // Validate identity
  if (identity !== undefined) {
    if (!isRecord(identity)) {
      return validationError("identity must be an object with a 'personas' array");
    }
    if (!Array.isArray(identity.personas)) {
      return validationError("identity.personas must be an array");
    }
    for (
      let i = 0; // let: loop counter
      i < identity.personas.length;
      i++
    ) {
      const err = validatePersonaEntry(identity.personas[i], i);
      if (err !== undefined) return { ok: false, error: err };
    }
  }

  // Validate refreshUser
  if (refreshUser !== undefined && typeof refreshUser !== "boolean") {
    return validationError("refreshUser must be a boolean");
  }

  // Validate selfModify
  const { selfModify } = config;
  if (selfModify !== undefined && typeof selfModify !== "boolean") {
    return validationError("selfModify must be a boolean");
  }

  // Construct validated options — type guards re-narrow fields that were
  // validated above by validateContentInput/validatePersonaEntry.
  return {
    ok: true,
    value: {
      basePath,
      ...(soul !== undefined && isContentInput(soul) ? { soul } : {}),
      ...(user !== undefined && isContentInput(user) ? { user } : {}),
      ...(identity !== undefined && isIdentityConfig(identity) ? { identity } : {}),
      ...(typeof refreshUser === "boolean" ? { refreshUser } : {}),
      ...(typeof selfModify === "boolean" ? { selfModify } : {}),
    },
  };
}
