/**
 * Self-test for the middleware contract suite.
 *
 * Exercises testMiddlewareContract with two mock implementations:
 * 1. A minimal middleware (name only, no hooks) — verifies the suite
 *    handles the "all hooks optional" case.
 * 2. A full middleware (all hooks implemented) — verifies every
 *    invariant assertion fires and passes.
 */

import { describe } from "bun:test";
import type {
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelStreamHandler,
  ToolHandler,
} from "@koi/core/middleware";
import { testMiddlewareContract } from "./index.js";

// ---------------------------------------------------------------------------
// Minimal middleware — name only, zero hooks
// ---------------------------------------------------------------------------

function createMinimalMiddleware(): KoiMiddleware {
  return { name: "minimal-test", describeCapabilities: () => undefined };
}

describe("middleware contract — minimal (no hooks)", () => {
  testMiddlewareContract({ createMiddleware: createMinimalMiddleware });
});

// ---------------------------------------------------------------------------
// Full middleware — all hooks implemented as pass-through
// ---------------------------------------------------------------------------

function createFullMiddleware(): KoiMiddleware {
  return {
    name: "full-test",
    describeCapabilities: () => undefined,
    priority: 100,

    onSessionStart: async () => {},
    onSessionEnd: async () => {},
    onBeforeTurn: async () => {},
    onAfterTurn: async () => {},

    wrapModelCall: async (_ctx, request, next: ModelHandler) => {
      return next(request);
    },

    wrapModelStream: (_ctx, request, next: ModelStreamHandler): AsyncIterable<ModelChunk> => {
      return next(request);
    },

    wrapToolCall: async (_ctx, request, next: ToolHandler) => {
      return next(request);
    },
  };
}

describe("middleware contract — full (all hooks)", () => {
  testMiddlewareContract({ createMiddleware: createFullMiddleware });
});
