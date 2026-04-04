import { describe, expect, test } from "bun:test";
import type {
  JsonObject,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  RichTrajectoryStep,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { TraceWrapperConfig } from "./trace-wrapper.js";
import { wrapMiddlewareWithTrace } from "./trace-wrapper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurnCtx(): TurnContext {
  return {
    session: {
      agentId: "test-agent",
      sessionId: "sid" as never,
      runId: "rid" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "tid" as never,
    messages: [],
    metadata: {},
  };
}

function createMockStore(): {
  readonly steps: RichTrajectoryStep[];
  readonly config: TraceWrapperConfig;
} {
  const steps: RichTrajectoryStep[] = [];
  return {
    steps,
    config: {
      store: {
        append: async (_docId: string, newSteps: readonly RichTrajectoryStep[]) => {
          steps.push(...newSteps);
        },
      } as never,
      docId: "test-doc",
    },
  };
}

function createMockStoreWithDeltas(): {
  readonly steps: RichTrajectoryStep[];
  readonly config: TraceWrapperConfig;
} {
  const steps: RichTrajectoryStep[] = [];
  return {
    steps,
    config: {
      store: {
        append: async (_docId: string, newSteps: readonly RichTrajectoryStep[]) => {
          steps.push(...newSteps);
        },
      } as never,
      docId: "test-doc",
      captureDeltas: true,
    },
  };
}

function makeModelRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    messages: [
      {
        senderId: "user",
        content: [{ kind: "text", text: "hello" }],
        timestamp: 0,
      },
    ],
    temperature: 0.7,
    maxTokens: 100,
    ...overrides,
  } as ModelRequest;
}

// ---------------------------------------------------------------------------
// B2: Middleware delta capture
// ---------------------------------------------------------------------------

describe("trace-wrapper delta capture", () => {
  test("records model request delta when middleware modifies request and captureDeltas is true", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const modifyingMiddleware: KoiMiddleware = {
      name: "temp-override",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) => {
        const { maxTokens: _, ...rest } = request;
        return next({ ...rest, temperature: 0.3 });
      },
    };

    const wrapped = wrapMiddlewareWithTrace(modifyingMiddleware, config);
    const originalRequest = makeModelRequest();
    const response = {
      content: "ok",
      model: "test",
      usage: { inputTokens: 10, outputTokens: 5 },
    } as ModelResponse;
    const next = async (_req: ModelRequest): Promise<ModelResponse> => response;

    await wrapped.wrapModelCall?.(makeTurnCtx(), originalRequest, next);

    await new Promise((r) => setTimeout(r, 50));

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.type).toBe("middleware_span");

    const delta = meta.requestDelta as JsonObject;
    expect(delta).toBeDefined();
    const changed = delta.changed as JsonObject;
    expect(changed.temperature).toEqual({ from: 0.7, to: 0.3 });
  });

  test("records tool input delta when middleware modifies tool input and captureDeltas is true", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const sanitizer: KoiMiddleware = {
      name: "sanitizer",
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, request, next) => {
        return next({
          ...request,
          input: { ...request.input, sanitized: true },
        });
      },
    };

    const wrapped = wrapMiddlewareWithTrace(sanitizer, config);
    const request: ToolRequest = {
      toolId: "bash",
      input: { command: "ls" },
    } as never;
    const response: ToolResponse = { output: "file.txt" };
    const next = async (_req: ToolRequest): Promise<ToolResponse> => response;

    await wrapped.wrapToolCall?.(makeTurnCtx(), request, next);

    await new Promise((r) => setTimeout(r, 50));

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    const delta = meta.inputDelta as JsonObject;
    expect(delta).toBeDefined();
    const added = delta.added as JsonObject;
    expect(added.sanitized).toBe(true);
  });

  test("no delta field when captureDeltas is false (default)", async () => {
    const { steps, config } = createMockStore();

    const modifyingMiddleware: KoiMiddleware = {
      name: "temp-override",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) => {
        return next({ ...request, temperature: 0.3 });
      },
    };

    const wrapped = wrapMiddlewareWithTrace(modifyingMiddleware, config);
    const response = {
      content: "ok",
      model: "test",
      usage: { inputTokens: 10, outputTokens: 5 },
    } as ModelResponse;

    await wrapped.wrapModelCall?.(makeTurnCtx(), makeModelRequest(), async () => response);

    await new Promise((r) => setTimeout(r, 50));

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.requestDelta).toBeUndefined();
  });

  test("no delta field when middleware does not modify the request", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const passthrough: KoiMiddleware = {
      name: "passthrough",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) => {
        return next(request);
      },
    };

    const wrapped = wrapMiddlewareWithTrace(passthrough, config);
    const response = {
      content: "ok",
      model: "test",
      usage: { inputTokens: 10, outputTokens: 5 },
    } as ModelResponse;

    await wrapped.wrapModelCall?.(makeTurnCtx(), makeModelRequest(), async () => response);

    await new Promise((r) => setTimeout(r, 50));

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.requestDelta).toBeUndefined();
  });
});
