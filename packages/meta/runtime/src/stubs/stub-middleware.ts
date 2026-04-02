import type { KoiMiddleware, MiddlewarePhase } from "@koi/core";

/**
 * Create a named passthrough middleware stub. Implements the KoiMiddleware
 * contract by calling next() without modification on model/tool calls.
 * Returns undefined for describeCapabilities (no capability injection).
 */
export function createStubMiddleware(
  name: string,
  phase: MiddlewarePhase = "resolve",
  priority = 500,
): KoiMiddleware {
  return {
    name,
    phase,
    priority,
    wrapModelCall: async (_ctx, request, next) => next(request),
    wrapToolCall: async (_ctx, request, next) => next(request),
    describeCapabilities: () => undefined,
  };
}

/**
 * The set of Phase 1 middleware names. Each gets a stub when not provided.
 * As real L2 packages land, their middleware replaces these stubs.
 */
export const PHASE1_MIDDLEWARE_NAMES = [
  "event-trace",
  "permissions",
  "hooks",
  "context-manager",
  "tool-execution",
] as const;
