/**
 * Pure validator for SupervisionConfig. Enforces invariants that cannot be
 * expressed in TypeScript (positive counts, unique child names, known
 * isolation values). Returns Result<SupervisionConfig, KoiError>.
 *
 * Exception (L0 rule): pure function operating only on L0 types, zero side
 * effects — permitted per architecture doc's L0 exception list.
 */

import { type KoiError, RETRYABLE_DEFAULTS, type Result } from "./errors.js";
import type { ChildSpec, SupervisionConfig } from "./supervision.js";

const VALID_ISOLATION: ReadonlySet<string> = new Set(["in-process", "subprocess"]);
const VALID_RESTART: ReadonlySet<string> = new Set(["permanent", "transient", "temporary"]);

export function validateSupervisionConfig(
  config: SupervisionConfig,
): Result<SupervisionConfig, KoiError> {
  if (!Number.isInteger(config.maxRestarts) || config.maxRestarts < 0) {
    return fail(`maxRestarts must be non-negative integer, got ${config.maxRestarts}`);
  }
  if (!Number.isFinite(config.maxRestartWindowMs) || config.maxRestartWindowMs <= 0) {
    return fail(`maxRestartWindowMs must be positive, got ${config.maxRestartWindowMs}`);
  }

  const seen = new Set<string>();
  for (const child of config.children) {
    const childResult = validateChildSpec(child);
    if (!childResult.ok) return childResult;
    if (seen.has(child.name)) {
      return fail(`duplicate child name: "${child.name}"`);
    }
    seen.add(child.name);
  }

  return { ok: true, value: config };
}

function validateChildSpec(spec: ChildSpec): Result<ChildSpec, KoiError> {
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    return fail("ChildSpec.name must be non-empty string");
  }
  if (!VALID_RESTART.has(spec.restart)) {
    return fail(`ChildSpec.restart unknown: "${spec.restart}"`);
  }
  if (spec.isolation !== undefined && !VALID_ISOLATION.has(spec.isolation)) {
    return fail(`ChildSpec.isolation unknown: "${spec.isolation}"`);
  }
  if (
    spec.shutdownTimeoutMs !== undefined &&
    (!Number.isFinite(spec.shutdownTimeoutMs) || spec.shutdownTimeoutMs < 0)
  ) {
    return fail(`ChildSpec.shutdownTimeoutMs must be non-negative, got ${spec.shutdownTimeoutMs}`);
  }
  return { ok: true, value: spec };
}

function fail(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}
