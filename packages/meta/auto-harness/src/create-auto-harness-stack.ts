import type { ForgeDemandSignal } from "@koi/core";
import type { PolicyCacheHandle } from "@koi/middleware-policy-cache";
import {
  type AutoHarnessConfig,
  type AutoHarnessError,
  type AutoHarnessEvent,
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
  const policyCacheMiddleware = {
    name: "policy-cache",
    phase: "intercept",
    priority: 50,
    describeCapabilities: () => undefined,
  } as const;
  const policyCacheHandle: PolicyCacheHandle = {
    middleware: policyCacheMiddleware,
    register: () => ({ ok: true as const, value: undefined }),
    evict: () => {},
    size: () => 0,
    dispose: () => {},
  };
  const maxSynthesesPerSession = resolveMaxSynthesesPerSession(config.maxSynthesesPerSession);
  let synthesesThisSession = 0;

  const emitEvent = (event: AutoHarnessEvent): void => {
    config.onEvent?.(event);
  };

  const reportError = (error: AutoHarnessError): void => {
    config.onError?.(error);
  };

  const synthesizeHarness = async (
    signal: ForgeDemandSignal,
  ): Promise<AutoHarnessSynthesisResult> => {
    emitEvent({ type: "synthesis-started", signal, stage: "generate" });
    if (synthesesThisSession >= maxSynthesesPerSession) {
      emitEvent({
        type: "synthesis-skipped",
        signal,
        stage: "generate",
        message: "session synthesis cap reached",
      });
      return null;
    }
    synthesesThisSession += 1;
    void config
      .generate("export function createMiddleware() {}")
      .catch((cause: unknown) =>
        reportError({ stage: "generate", message: "generate failed", cause }),
      );
    return null;
  };

  return {
    policyCacheMiddleware,
    policyCacheHandle,
    synthesizeHarness,
    resetSession: () => {
      synthesesThisSession = 0;
      emitEvent({ type: "session-reset", message: "session synthesis state cleared" });
    },
    maxSynthesesPerSession,
  };
}
