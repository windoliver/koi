import type { KoiMiddleware } from "@koi/core";
import {
  type AutoHarnessConfig,
  type AutoHarnessPolicyCacheHandle,
  type AutoHarnessStack,
  type AutoHarnessSynthesisResult,
  DEFAULT_MAX_SYNTHESES_PER_SESSION,
} from "./types.js";

function resolveMaxSynthesesPerSession(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_SYNTHESES_PER_SESSION;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `@koi/auto-harness: maxSynthesesPerSession must be a positive integer (got ${String(value)})`,
    );
  }
  return value;
}

export function createAutoHarnessStack(config: AutoHarnessConfig): AutoHarnessStack {
  const policyCacheMiddleware: KoiMiddleware = {
    name: "policy-cache",
    phase: "intercept",
    priority: 50,
    describeCapabilities: () => undefined,
  };
  const policyCacheHandle: AutoHarnessPolicyCacheHandle = {
    middleware: policyCacheMiddleware,
  };
  const maxSynthesesPerSession = resolveMaxSynthesesPerSession(config.maxSynthesesPerSession);
  let synthesesThisSession = 0;

  const synthesizeHarness = async (): Promise<AutoHarnessSynthesisResult> => {
    if (synthesesThisSession >= maxSynthesesPerSession) {
      return null;
    }
    synthesesThisSession += 1;
    return null;
  };

  return {
    policyCacheMiddleware,
    policyCacheHandle,
    synthesizeHarness,
    resetSession: () => {
      synthesesThisSession = 0;
    },
    maxSynthesesPerSession,
  };
}
