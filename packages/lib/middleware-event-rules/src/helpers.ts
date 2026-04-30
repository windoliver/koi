/**
 * Internal helpers extracted from rule-middleware.ts to keep the
 * orchestrating factory under the project's per-file/per-function
 * complexity budget. No public exports — this module is private to
 * the @koi/middleware-event-rules package.
 */

import type { ToolResponse } from "@koi/core";
import type { ActionContext, EventRulesConfig } from "./types.js";

/** Flattens primitive top-level fields for predicate access. */
export function flattenInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      flat[key] = value;
    }
  }
  return flat;
}

/**
 * Classifies a `ToolResponse` as a failure for rule-evaluation purposes.
 * Recognized failure shapes (matches conventions used by peer L2 packages
 * — task-anchor, event-trace, hook-dispatch — so policy rules don't fail
 * open against the same blocked/error responses those packages already
 * treat as failures):
 *   - `metadata.error === true`              (generic error sentinel)
 *   - `metadata.blocked === true`            (call-limits / event-rules)
 *   - `metadata.blockedByHook === true`      (hook veto contract)
 *   - `output` payload with explicit `ok: false`
 *   - `output: { error: string, code: string }` (exfiltration-guard
 *     deny shape — peer security middleware that does not set
 *     `metadata.blocked` but returns a structured error payload).
 */
export function isToolFailure(response: ToolResponse): boolean {
  const md = response.metadata;
  if (md !== undefined) {
    if (md.error === true) return true;
    const flags = md as Record<string, unknown>;
    if (flags.blocked === true) return true;
    if (flags.blockedByHook === true) return true;
  }
  const out = response.output;
  if (out !== null && typeof out === "object") {
    const o = out as Record<string, unknown>;
    if ("ok" in o && o.ok === false) return true;
    if (typeof o.error === "string" && typeof o.code === "string") return true;
  }
  return false;
}

/**
 * Inspects the ruleset for side-effecting action types whose dependency is
 * not present on `actionContext`. When `strictActions` is on, returns the
 * list of unmet requirements; the factory throws on a non-empty list.
 */
export function findMissingActionHandlers(
  ruleset: EventRulesConfig["ruleset"],
  ctx: ActionContext,
): readonly string[] {
  const unmet = new Set<string>();
  for (const rule of ruleset.rules) {
    for (const action of rule.actions) {
      if (action.type === "escalate" && ctx.requestEscalation === undefined) {
        unmet.add(`'${rule.name}' uses 'escalate' but no requestEscalation handler is wired`);
      }
      if (action.type === "notify" && ctx.sendNotification === undefined) {
        unmet.add(`'${rule.name}' uses 'notify' but no sendNotification handler is wired`);
      }
      if (action.type === "emit" && ctx.emitEvent === undefined) {
        unmet.add(`'${rule.name}' uses 'emit' but no emitEvent handler is wired`);
      }
    }
  }
  return [...unmet];
}

export interface ResponseClassification {
  readonly ok: boolean;
  readonly blocked: boolean;
  readonly blockedByHook: boolean;
  readonly reason: string | undefined;
}

/**
 * Surfaces failure-cause discriminators so rules can distinguish policy
 * denials (permission, hook veto, call-limit, exfiltration guard) from
 * real execution failures. Exfiltration-guard's denial shape is recognized
 * by its explicit `"Exfiltration guard:"` error-message prefix (a unique
 * marker baked into the package), NOT by the generic `{ error, code }`
 * output shape — many ordinary tool errors (e.g. `memory_recall` returning
 * `{ error, code: "VALIDATION" }` on bad input) use the same shape and
 * must NOT be silently re-labeled as policy blocks.
 */
export function classifyResponse(response: ToolResponse): ResponseClassification {
  const ok = !isToolFailure(response);
  const md = response.metadata as Record<string, unknown> | undefined;
  const out = response.output as Record<string, unknown> | null;
  const isExfilDenyShape =
    out !== null &&
    typeof out === "object" &&
    typeof out.error === "string" &&
    out.error.startsWith("Exfiltration guard:") &&
    typeof out.code === "string" &&
    md?.blocked !== true &&
    md?.blockedByHook !== true;
  const blocked = md?.blocked === true || isExfilDenyShape;
  const blockedByHook = md?.blockedByHook === true;
  const explicitReason = typeof md?.reason === "string" ? md.reason : undefined;
  const reason = explicitReason ?? (isExfilDenyShape ? `exfiltration_${out.code}` : undefined);
  return { ok, blocked, blockedByHook, reason };
}

interface Logger {
  readonly info: (m: string) => void;
  readonly warn: (m: string) => void;
  readonly error: (m: string) => void;
  readonly debug: (m: string) => void;
}

const FALLBACK_LOGGER: Logger = {
  info: (): void => {},
  warn: (m: string): void => console.warn(m),
  error: (m: string): void => console.error(m),
  debug: (): void => {},
};

/**
 * Best-effort denial log. A misbehaving logger or onBlock callback must
 * never replace the canonical blocked response with an exception, so we
 * swallow all errors and fall back to console.warn. Errors here would
 * change a policy denial into an unexpected error for downstream
 * retry/trace classifiers.
 */
export function emitDenialLog(
  toolId: string,
  sessionId: string,
  logger: ActionContext["logger"],
): void {
  const message = `[event-rules] blocked tool '${toolId}' (session=${sessionId}, reason=event_rules_skip)`;
  try {
    if (logger !== undefined) {
      logger.warn(message);
    } else {
      console.warn(message);
    }
  } catch {
    try {
      console.warn(message);
    } catch {
      /* swallow — deny path must not throw */
    }
  }
}

export const FALLBACK_DENY_LOGGER: Logger = FALLBACK_LOGGER;
