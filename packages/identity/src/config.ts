/**
 * Identity middleware configuration types and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";

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
  readonly instructions?: string | { readonly path: string };
}

/** Options for creating the identity middleware. */
export interface CreateIdentityOptions {
  readonly personas: readonly ChannelPersonaConfig[];
  /** Base path for resolving relative instruction file paths. */
  readonly basePath?: string;
}

/** Validates that a ChannelPersonaConfig entry is well-formed. */
function validatePersonaEntry(entry: unknown, index: number): KoiError | undefined {
  if (entry === null || typeof entry !== "object") {
    return {
      code: "VALIDATION",
      message: `personas[${index}] must be a non-null object`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.channelId !== "string" || e.channelId.length === 0) {
    return {
      code: "VALIDATION",
      message: `personas[${index}].channelId must be a non-empty string`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  if (e.name !== undefined && typeof e.name !== "string") {
    return {
      code: "VALIDATION",
      message: `personas[${index}].name must be a string`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  if (e.avatar !== undefined && typeof e.avatar !== "string") {
    return {
      code: "VALIDATION",
      message: `personas[${index}].avatar must be a string`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  if (e.instructions !== undefined) {
    if (typeof e.instructions === "object" && e.instructions !== null) {
      const ins = e.instructions as Record<string, unknown>;
      if (typeof ins.path !== "string") {
        return {
          code: "VALIDATION",
          message: `personas[${index}].instructions.path must be a string`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        };
      }
    } else if (typeof e.instructions !== "string") {
      return {
        code: "VALIDATION",
        message: `personas[${index}].instructions must be a string or { path: string }`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
  }
  return undefined;
}

/** Validates CreateIdentityOptions, returning a typed Result. */
export function validateIdentityConfig(config: unknown): Result<CreateIdentityOptions, KoiError> {
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

  if (!Array.isArray(c.personas)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'personas' array",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  for (let i = 0; i < c.personas.length; i++) {
    const err = validatePersonaEntry(c.personas[i], i);
    if (err !== undefined) {
      return { ok: false, error: err };
    }
  }

  if (c.basePath !== undefined && typeof c.basePath !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "basePath must be a string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: config as CreateIdentityOptions };
}
