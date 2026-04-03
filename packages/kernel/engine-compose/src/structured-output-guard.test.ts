import { describe, expect, it, mock } from "bun:test";
import type {
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  TurnContext,
} from "@koi/core";
import { createStructuredOutputGuard } from "./structured-output-guard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubTurnCtx = {} as TurnContext;

function makeModelRequest(messageCount = 1): ModelRequest {
  // Cast to satisfy InboundMessage shape in tests — we only care about array length
  return {
    messages: Array.from({ length: messageCount }, () => ({
      role: "user" as const,
      content: [{ kind: "text" as const, text: "test" }],
    })) as unknown as ModelRequest["messages"],
  };
}

const stubModelResponse: ModelResponse = {
  content: "done",
  model: "test",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createStructuredOutputGuard", () => {
  it("has correct name and phase", () => {
    const guard = createStructuredOutputGuard({ requiredToolName: "HookVerdict" });
    expect(guard.name).toBe("koi:structured-output-guard");
    expect(guard.phase).toBe("intercept");
  });

  it("passes through model call unchanged when required tool was called", async () => {
    const guard = createStructuredOutputGuard({ requiredToolName: "HookVerdict" });
    await guard.onSessionStart?.(stubTurnCtx.session ?? ({} as never));

    // Simulate tool call
    const toolNext = mock<ToolHandler>().mockResolvedValue({ output: '{"ok":true}' });
    await guard.wrapToolCall?.(stubTurnCtx, { toolId: "HookVerdict", input: {} }, toolNext);

    // Model call should not be modified
    const modelNext = mock<ModelHandler>().mockResolvedValue(stubModelResponse);
    const request = makeModelRequest();
    await guard.wrapModelCall?.(stubTurnCtx, request, modelNext);

    const passedRequest = modelNext.mock.calls[0]?.[0] as ModelRequest | undefined;
    expect(passedRequest).toBeDefined();
    // No hint injected — request is unchanged
    expect(passedRequest?.metadata).toBeUndefined();
  });

  it("injects hint into metadata when required tool not yet called", async () => {
    const guard = createStructuredOutputGuard({ requiredToolName: "HookVerdict" });
    await guard.onSessionStart?.(stubTurnCtx.session ?? ({} as never));

    const modelNext = mock<ModelHandler>().mockResolvedValue(stubModelResponse);
    const request = makeModelRequest(2); // needs messages to trigger hint
    await guard.wrapModelCall?.(stubTurnCtx, request, modelNext);

    const passedRequest = modelNext.mock.calls[0]?.[0] as ModelRequest | undefined;
    expect(passedRequest).toBeDefined();
    expect(passedRequest?.systemPrompt).toContain("HookVerdict");
  });

  it("does not inject hint on first turn (no messages)", async () => {
    const guard = createStructuredOutputGuard({ requiredToolName: "HookVerdict" });
    await guard.onSessionStart?.(stubTurnCtx.session ?? ({} as never));

    const modelNext = mock<ModelHandler>().mockResolvedValue(stubModelResponse);
    const request = makeModelRequest(0); // empty messages
    await guard.wrapModelCall?.(stubTurnCtx, request, modelNext);

    const passedRequest = modelNext.mock.calls[0]?.[0] as ModelRequest | undefined;
    expect(passedRequest?.systemPrompt).toBeUndefined();
  });

  it("stops injecting after maxReprompts", async () => {
    const guard = createStructuredOutputGuard({
      requiredToolName: "HookVerdict",
      maxReprompts: 1,
    });
    await guard.onSessionStart?.(stubTurnCtx.session ?? ({} as never));

    const modelNext = mock<ModelHandler>().mockResolvedValue(stubModelResponse);
    const request = makeModelRequest(2);

    // First call: hint injected into systemPrompt
    await guard.wrapModelCall?.(stubTurnCtx, request, modelNext);
    const first = modelNext.mock.calls[0]?.[0] as ModelRequest | undefined;
    expect(first?.systemPrompt).toContain("HookVerdict");

    // Second call: maxReprompts=1 exhausted, no more hints
    await guard.wrapModelCall?.(stubTurnCtx, request, modelNext);
    const second = modelNext.mock.calls[1]?.[0] as ModelRequest | undefined;
    expect(second?.systemPrompt).toBeUndefined();
  });

  it("tracks tool call by name, ignores other tools", async () => {
    const guard = createStructuredOutputGuard({ requiredToolName: "HookVerdict" });
    await guard.onSessionStart?.(stubTurnCtx.session ?? ({} as never));

    // Call a different tool — should NOT satisfy the guard
    const toolNext = mock<ToolHandler>().mockResolvedValue({ output: "ok" });
    await guard.wrapToolCall?.(stubTurnCtx, { toolId: "Read", input: {} }, toolNext);

    // Model call should still get hint
    const modelNext = mock<ModelHandler>().mockResolvedValue(stubModelResponse);
    await guard.wrapModelCall?.(stubTurnCtx, makeModelRequest(2), modelNext);
    const passed = modelNext.mock.calls[0]?.[0] as ModelRequest | undefined;
    expect(passed?.systemPrompt).toContain("HookVerdict");
  });

  it("resets state on session start", async () => {
    const guard = createStructuredOutputGuard({ requiredToolName: "HookVerdict" });

    // First session: call the tool
    await guard.onSessionStart?.(stubTurnCtx.session ?? ({} as never));
    const toolNext = mock<ToolHandler>().mockResolvedValue({ output: "ok" });
    await guard.wrapToolCall?.(stubTurnCtx, { toolId: "HookVerdict", input: {} }, toolNext);

    // New session: tool state should be reset
    await guard.onSessionStart?.(stubTurnCtx.session ?? ({} as never));
    const modelNext = mock<ModelHandler>().mockResolvedValue(stubModelResponse);
    await guard.wrapModelCall?.(stubTurnCtx, makeModelRequest(2), modelNext);

    // Hint should be injected again (tool not called in new session)
    const passed = modelNext.mock.calls[0]?.[0] as ModelRequest | undefined;
    expect(passed?.systemPrompt).toContain("HookVerdict");
  });

  it("describeCapabilities includes tool name", () => {
    const guard = createStructuredOutputGuard({ requiredToolName: "HookVerdict" });
    const caps = guard.describeCapabilities(stubTurnCtx);
    expect(caps?.description).toContain("HookVerdict");
  });
});
