/**
 * Configuration for the tool-selector middleware.
 */

import type { ToolDescriptor } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { InboundMessage } from "@koi/core/message";

export interface ToolSelectorConfig {
  /** Caller-provided function that selects relevant tool names for a query. */
  readonly selectTools: (
    query: string,
    tools: readonly ToolDescriptor[],
  ) => Promise<readonly string[]>;
  /** Tool names always included regardless of selection. */
  readonly alwaysInclude?: readonly string[];
  /** Max tools to return from selector (default: 10). */
  readonly maxTools?: number;
  /** Min tools threshold to activate filtering (default: 5). */
  readonly minTools?: number;
  /** Custom query extraction from messages (default: last message text). */
  readonly extractQuery?: (messages: readonly InboundMessage[]) => string;
}

export function validateToolSelectorConfig(config: unknown): Result<ToolSelectorConfig, KoiError> {
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

  if (typeof c.selectTools !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'selectTools' function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.alwaysInclude !== undefined) {
    if (!Array.isArray(c.alwaysInclude) || !c.alwaysInclude.every((x) => typeof x === "string")) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "alwaysInclude must be an array of strings",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.maxTools !== undefined) {
    if (typeof c.maxTools !== "number" || c.maxTools <= 0 || !Number.isInteger(c.maxTools)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "maxTools must be a positive integer",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.minTools !== undefined) {
    if (typeof c.minTools !== "number" || c.minTools < 0 || !Number.isInteger(c.minTools)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "minTools must be a non-negative integer",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.extractQuery !== undefined && typeof c.extractQuery !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "extractQuery must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: config as ToolSelectorConfig };
}
