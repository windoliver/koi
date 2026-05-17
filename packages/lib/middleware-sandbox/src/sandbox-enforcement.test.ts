import { describe, expect, it, mock } from "bun:test";
import type {
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolPolicy,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import type { KoiRuntimeError } from "@koi/errors";
import { createSandboxEnforcementMiddleware } from "./index.js";

const SANDBOXED_POLICY: ToolPolicy = {
  sandbox: true,
  capabilities: {},
};

const UNSANDBOXED_POLICY: ToolPolicy = {
  sandbox: false,
  capabilities: {},
};

const PROVIDER_BACKED_SANDBOXED_POLICY: ToolPolicy = {
  sandbox: true,
  sandboxBacking: "provider",
  capabilities: {},
};

function mockTurnCtx(): TurnContext {
  const sid = sessionId("sess-sandbox");
  const rid = runId("run-sandbox");
  const session: SessionContext = {
    agentId: "agent-sandbox",
    sessionId: sid,
    runId: rid,
    metadata: {},
  };
  return {
    session,
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
  };
}

function modelRequest(): ModelRequest {
  return {
    messages: [],
    tools: [
      { name: "sandboxed", description: "needs a sandbox", inputSchema: {} },
      { name: "plain", description: "does not need a sandbox", inputSchema: {} },
      { name: "unknown", description: "legacy descriptor without policy", inputSchema: {} },
    ],
  };
}

function modelResponse(): ModelResponse {
  return { content: "ok", model: "test-model" };
}

function toolRequest(toolId: string): ToolRequest {
  return { toolId, input: {} };
}

function toolResponse(): ToolResponse {
  return { output: "ok" };
}

describe("createSandboxEnforcementMiddleware", () => {
  it("throws PERMISSION for a sandboxed tool when required and no executor is configured", async () => {
    const middleware = createSandboxEnforcementMiddleware({
      required: true,
      executorConfigured: false,
      policies: { sandboxed: SANDBOXED_POLICY },
    });
    const next = mock(async (_request: ToolRequest) => toolResponse());

    await expect(
      middleware.wrapToolCall?.(mockTurnCtx(), toolRequest("sandboxed"), next),
    ).rejects.toMatchObject({
      code: "PERMISSION",
      retryable: false,
    } satisfies Partial<KoiRuntimeError>);
    expect(next).toHaveBeenCalledTimes(0);
  });

  it("warns and allows sandboxed tool calls when not required and no executor is configured", async () => {
    const onWarning = mock(() => {});
    const middleware = createSandboxEnforcementMiddleware({
      required: false,
      executorConfigured: false,
      policies: { sandboxed: SANDBOXED_POLICY },
      onWarning,
    });
    const response = toolResponse();
    const next = mock(async (_request: ToolRequest) => response);

    const result = await middleware.wrapToolCall?.(mockTurnCtx(), toolRequest("sandboxed"), next);

    expect(result).toBe(response);
    expect(next).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith({
      kind: "tool-call",
      toolId: "sandboxed",
      reason: "sandbox_required_without_executor",
    });
  });

  it("allows unsandboxed and unknown-policy tools without warning", async () => {
    const onWarning = mock(() => {});
    const middleware = createSandboxEnforcementMiddleware({
      required: true,
      executorConfigured: false,
      policies: { plain: UNSANDBOXED_POLICY },
      onWarning,
    });
    const next = mock(async (_request: ToolRequest) => toolResponse());

    await middleware.wrapToolCall?.(mockTurnCtx(), toolRequest("plain"), next);
    await middleware.wrapToolCall?.(mockTurnCtx(), toolRequest("unknown"), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenCalledTimes(0);
  });

  it("filters known sandboxed tools from model context when no executor is configured", async () => {
    const middleware = createSandboxEnforcementMiddleware({
      required: true,
      executorConfigured: false,
      policies: {
        sandboxed: SANDBOXED_POLICY,
        plain: UNSANDBOXED_POLICY,
      },
    });
    const next = mock(async (request: ModelRequest) => {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["plain", "unknown"]);
      return modelResponse();
    });

    const result = await middleware.wrapModelCall?.(mockTurnCtx(), modelRequest(), next);

    expect(result).toEqual(modelResponse());
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("filters known sandboxed tools from streaming model context", async () => {
    const middleware = createSandboxEnforcementMiddleware({
      required: true,
      executorConfigured: false,
      policies: {
        sandboxed: SANDBOXED_POLICY,
        plain: UNSANDBOXED_POLICY,
      },
    });
    async function* emptyStream(): AsyncIterable<never> {}
    const next = mock((request: ModelRequest) => {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["plain", "unknown"]);
      return emptyStream();
    });

    const stream = middleware.wrapModelStream?.(mockTurnCtx(), modelRequest(), next);
    for await (const _chunk of stream ?? emptyStream()) {
      // Drain the stream so the wrapper invokes the handler.
    }

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps all tools visible in non-required mode so local runtimes are unaffected", async () => {
    const onWarning = mock(() => {});
    const middleware = createSandboxEnforcementMiddleware({
      required: false,
      executorConfigured: false,
      policies: { sandboxed: SANDBOXED_POLICY },
      onWarning,
    });
    const next = mock(async (request: ModelRequest) => {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["sandboxed", "plain", "unknown"]);
      return modelResponse();
    });

    await middleware.wrapModelCall?.(mockTurnCtx(), modelRequest(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledTimes(0);
  });

  it("keeps sandboxed tools visible only when that tool is backed by the executor", async () => {
    const middleware = createSandboxEnforcementMiddleware({
      required: true,
      sandboxBackedTools: ["sandboxed"],
      policies: { sandboxed: SANDBOXED_POLICY },
    });
    const next = mock(async (request: ModelRequest) => {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["sandboxed", "plain", "unknown"]);
      return modelResponse();
    });

    await middleware.wrapModelCall?.(mockTurnCtx(), modelRequest(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("filters unrelated sandboxed tools even when another tool is backed", async () => {
    const middleware = createSandboxEnforcementMiddleware({
      required: true,
      sandboxBackedTools: ["other_sandboxed"],
      policies: { sandboxed: SANDBOXED_POLICY },
    });
    const next = mock(async (request: ModelRequest) => {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["plain", "unknown"]);
      return modelResponse();
    });

    await middleware.wrapModelCall?.(mockTurnCtx(), modelRequest(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("filters provider-backed sandboxed tools unless the host explicitly trusts the provider", async () => {
    const middleware = createSandboxEnforcementMiddleware({
      required: true,
      policies: { sandboxed: PROVIDER_BACKED_SANDBOXED_POLICY },
    });
    const next = mock(async (request: ModelRequest) => {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["plain", "unknown"]);
      return modelResponse();
    });

    await middleware.wrapModelCall?.(mockTurnCtx(), modelRequest(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keeps explicitly trusted provider-backed sandboxed tools visible in required mode", async () => {
    const middleware = createSandboxEnforcementMiddleware({
      required: true,
      isProviderSandboxBacked: (toolId, policy) =>
        toolId === "sandboxed" && policy === PROVIDER_BACKED_SANDBOXED_POLICY,
      policies: { sandboxed: PROVIDER_BACKED_SANDBOXED_POLICY },
    });
    const next = mock(async (request: ModelRequest) => {
      expect(request.tools?.map((tool) => tool.name)).toEqual(["sandboxed", "plain", "unknown"]);
      return modelResponse();
    });

    await middleware.wrapModelCall?.(mockTurnCtx(), modelRequest(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
