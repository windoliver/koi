/**
 * ExecApprovalsConfig interface and validation.
 */

import type { JsonObject } from "@koi/core/common";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { ExecApprovalRequest, ExecRulesStore, ProgressiveDecision } from "./types.js";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

export interface ExecApprovalsConfig {
  readonly rules: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
    readonly ask: readonly string[];
  };
  /** Called when an ask rule fires. Must return a ProgressiveDecision. */
  readonly onAsk: (req: ExecApprovalRequest) => Promise<ProgressiveDecision>;
  /** Backing store for "always" decisions. Defaults to createInMemoryRulesStore(). */
  readonly store?: ExecRulesStore;
  /** Timeout for onAsk. Defaults to DEFAULT_APPROVAL_TIMEOUT_MS (30_000 ms). */
  readonly approvalTimeoutMs?: number;
  /** Called when store.save() fails. Tool call proceeds regardless. */
  readonly onSaveError?: (error: unknown) => void;
  /** Called when store.load() fails. Session starts with empty accumulated state. */
  readonly onLoadError?: (error: unknown) => void;
  /**
   * Extract a command string from the tool input for compound pattern matching.
   * Defaults to defaultExtractCommand.
   */
  readonly extractCommand?: (input: JsonObject) => string;
}

export function validateExecApprovalsConfig(
  config: unknown,
): Result<ExecApprovalsConfig, KoiError> {
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

  if (!c.rules || typeof c.rules !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires 'rules' with allow, deny, and ask arrays",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const rules = c.rules as Record<string, unknown>;
  if (!Array.isArray(rules.allow) || !Array.isArray(rules.deny) || !Array.isArray(rules.ask)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Rules must contain 'allow', 'deny', and 'ask' arrays",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (typeof c.onAsk !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires 'onAsk' to be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.approvalTimeoutMs !== undefined) {
    if (typeof c.approvalTimeoutMs !== "number" || c.approvalTimeoutMs <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "approvalTimeoutMs must be a positive number",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: config as ExecApprovalsConfig };
}
