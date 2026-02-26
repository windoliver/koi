/**
 * Direct unit tests for the extracted handleToolCall + isToolCallPayload.
 *
 * Each test builds a fully mocked ToolCallHandlerDeps, removing all need
 * for real transports, resolvers, or framework wiring.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { DelegationScope, KoiError, Result, ScopeChecker, Tool } from "@koi/core";
import type { ToolCallHandlerDeps } from "./tool-call-handler.js";
import { executeWithSignal, handleToolCall, isToolCallPayload } from "./tool-call-handler.js";
import type { LocalResolver, ToolMeta } from "./tools/local-resolver.js";
import type { NodeFrame } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFrame(overrides?: Partial<NodeFrame>): NodeFrame {
  return {
    nodeId: "test-node",
    agentId: "agent-1",
    correlationId: "corr-1",
    kind: "tool_call",
    payload: {
      toolName: "read_file",
      args: { path: "/tmp/test.txt" },
      callerAgentId: "caller-1",
    },
    ...overrides,
  };
}

function makeTool(result: unknown = "ok"): Tool {
  return {
    descriptor: { name: "read_file", description: "Read a file", inputSchema: {} },
    trustTier: "sandbox",
    execute: mock(() => Promise.resolve(result)),
  };
}

function makeResolver(tool?: Tool): LocalResolver {
  const loadResult: Result<Tool, KoiError> = tool
    ? { ok: true, value: tool }
    : { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
  return {
    discover: mock(() => Promise.resolve([] as readonly ToolMeta[])),
    list: mock(() => [] as readonly ToolMeta[]),
    load: mock(() => Promise.resolve(loadResult)),
    source: mock(() =>
      Promise.resolve({
        ok: false,
        error: { code: "NOT_FOUND", message: "no source", retryable: false },
      } as Result<never, KoiError>),
    ),
  };
}

function makeChecker(allows: boolean): ScopeChecker {
  return { isAllowed: mock(() => allows) };
}

function makeScope(): DelegationScope {
  return { permissions: { allow: ["*"] } };
}

function makeDeps(overrides?: Partial<ToolCallHandlerDeps>): ToolCallHandlerDeps {
  return {
    nodeId: "test-node",
    permission: { checker: makeChecker(true), scope: makeScope() },
    resolver: makeResolver(makeTool()),
    sendOutbound: mock(() => {}),
    emit: mock(() => {}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isToolCallPayload
// ---------------------------------------------------------------------------

describe("isToolCallPayload", () => {
  it("returns false for null", () => {
    expect(isToolCallPayload(null)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isToolCallPayload("string")).toBe(false);
    expect(isToolCallPayload(42)).toBe(false);
    expect(isToolCallPayload(true)).toBe(false);
    expect(isToolCallPayload(undefined)).toBe(false);
  });

  it("returns false for missing toolName", () => {
    expect(isToolCallPayload({ callerAgentId: "a" })).toBe(false);
  });

  it("returns false for empty toolName", () => {
    expect(isToolCallPayload({ toolName: "", callerAgentId: "a" })).toBe(false);
  });

  it("returns false for missing callerAgentId", () => {
    expect(isToolCallPayload({ toolName: "read_file" })).toBe(false);
  });

  it("returns false for non-string callerAgentId", () => {
    expect(isToolCallPayload({ toolName: "read_file", callerAgentId: 42 })).toBe(false);
  });

  it("returns true for valid payload", () => {
    expect(isToolCallPayload({ toolName: "read_file", callerAgentId: "a" })).toBe(true);
  });

  it("returns true when args and zone are present", () => {
    expect(
      isToolCallPayload({
        toolName: "read_file",
        callerAgentId: "a",
        args: { path: "/tmp" },
        zone: "z1",
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleToolCall
// ---------------------------------------------------------------------------

describe("handleToolCall", () => {
  let deps: ToolCallHandlerDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("emits agent_crashed for malformed payload", async () => {
    const frame = makeFrame({ payload: { bad: true } });
    await handleToolCall(frame, deps);

    expect(deps.emit).toHaveBeenCalledTimes(1);
    expect((deps.emit as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("agent_crashed");
    expect(deps.sendOutbound).not.toHaveBeenCalled();
  });

  it("sends permission_denied when no checker configured (deny-by-default)", async () => {
    const noDeps = makeDeps({ permission: undefined });
    const frame = makeFrame();
    await handleToolCall(frame, noDeps);

    expect(noDeps.sendOutbound).toHaveBeenCalledTimes(1);
    const sent = (noDeps.sendOutbound as ReturnType<typeof mock>).mock.calls[0]?.[0] as NodeFrame;
    expect(sent.kind).toBe("tool_error");
    expect((sent.payload as { code: string }).code).toBe("permission_denied");
  });

  it("sends permission_denied when checker denies", async () => {
    const denyDeps = makeDeps({
      permission: { checker: makeChecker(false), scope: makeScope() },
    });
    const frame = makeFrame();
    await handleToolCall(frame, denyDeps);

    expect(denyDeps.sendOutbound).toHaveBeenCalledTimes(1);
    const sent = (denyDeps.sendOutbound as ReturnType<typeof mock>).mock.calls[0]?.[0] as NodeFrame;
    expect(sent.kind).toBe("tool_error");
    expect((sent.payload as { code: string }).code).toBe("permission_denied");
    expect((sent.payload as { message: string }).message).toContain("denied");
  });

  it("sends not_found when tool does not exist", async () => {
    const noToolDeps = makeDeps({ resolver: makeResolver() });
    const frame = makeFrame();
    await handleToolCall(frame, noToolDeps);

    expect(noToolDeps.sendOutbound).toHaveBeenCalledTimes(1);
    const sent = (noToolDeps.sendOutbound as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as NodeFrame;
    expect(sent.kind).toBe("tool_error");
    expect((sent.payload as { code: string }).code).toBe("not_found");
  });

  it("sends tool_result on successful execution", async () => {
    const tool = makeTool({ content: "hello" });
    const successDeps = makeDeps({ resolver: makeResolver(tool) });
    const frame = makeFrame();
    await handleToolCall(frame, successDeps);

    expect(successDeps.sendOutbound).toHaveBeenCalledTimes(1);
    const sent = (successDeps.sendOutbound as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as NodeFrame;
    expect(sent.kind).toBe("tool_result");
    expect((sent.payload as { result: unknown }).result).toEqual({ content: "hello" });
  });

  it("sends execution_error and emits agent_crashed when tool throws", async () => {
    const failTool: Tool = {
      descriptor: { name: "read_file", description: "Read a file", inputSchema: {} },
      trustTier: "sandbox",
      execute: mock(() => Promise.reject(new Error("disk full"))),
    };
    const failDeps = makeDeps({ resolver: makeResolver(failTool) });
    const frame = makeFrame();
    await handleToolCall(frame, failDeps);

    expect(failDeps.sendOutbound).toHaveBeenCalledTimes(1);
    const sent = (failDeps.sendOutbound as ReturnType<typeof mock>).mock.calls[0]?.[0] as NodeFrame;
    expect(sent.kind).toBe("tool_error");
    expect((sent.payload as { code: string }).code).toBe("execution_error");

    expect(failDeps.emit).toHaveBeenCalledTimes(1);
    expect((failDeps.emit as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("agent_crashed");
  });

  it("passes correct args to tool.execute()", async () => {
    const tool = makeTool("result");
    const argsDeps = makeDeps({ resolver: makeResolver(tool) });
    const frame = makeFrame({
      payload: { toolName: "read_file", args: { path: "/foo" }, callerAgentId: "c1" },
    });
    await handleToolCall(frame, argsDeps);

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect((tool.execute as ReturnType<typeof mock>).mock.calls[0]?.[0]).toEqual({ path: "/foo" });
  });

  it("defaults args to empty object when undefined", async () => {
    const tool = makeTool("result");
    const argsDeps = makeDeps({ resolver: makeResolver(tool) });
    const frame = makeFrame({
      payload: { toolName: "read_file", callerAgentId: "c1" },
    });
    await handleToolCall(frame, argsDeps);

    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect((tool.execute as ReturnType<typeof mock>).mock.calls[0]?.[0]).toEqual({});
  });

  it("includes correct agentId and correlationId in response frames", async () => {
    const frame = makeFrame({ agentId: "my-agent", correlationId: "my-corr" });
    await handleToolCall(frame, deps);

    const sent = (deps.sendOutbound as ReturnType<typeof mock>).mock.calls[0]?.[0] as NodeFrame;
    expect(sent.agentId).toBe("my-agent");
    expect(sent.correlationId).toBe("my-corr");
    expect(sent.nodeId).toBe("test-node");
  });

  it("sends timeout when tool execution exceeds timeoutMs", async () => {
    const slowTool: Tool = {
      descriptor: { name: "read_file", description: "Slow tool", inputSchema: {} },
      trustTier: "sandbox",
      execute: mock(() => new Promise(() => {})), // never resolves
    };
    const timeoutDeps = makeDeps({
      resolver: makeResolver(slowTool),
      timeoutMs: 50,
    });
    const frame = makeFrame();
    await handleToolCall(frame, timeoutDeps);

    expect(timeoutDeps.sendOutbound).toHaveBeenCalledTimes(1);
    const sent = (timeoutDeps.sendOutbound as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as NodeFrame;
    expect(sent.kind).toBe("tool_error");
    expect((sent.payload as { code: string }).code).toBe("timeout");
    expect((sent.payload as { message: string }).message).toContain("timed out");

    expect(timeoutDeps.emit).toHaveBeenCalledTimes(1);
    expect((timeoutDeps.emit as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("agent_crashed");
  });

  it("clears timeout when tool completes before deadline", async () => {
    const tool = makeTool("fast-result");
    const fastDeps = makeDeps({ resolver: makeResolver(tool), timeoutMs: 5_000 });
    const frame = makeFrame();
    await handleToolCall(frame, fastDeps);

    const sent = (fastDeps.sendOutbound as ReturnType<typeof mock>).mock.calls[0]?.[0] as NodeFrame;
    expect(sent.kind).toBe("tool_result");
    expect((sent.payload as { result: unknown }).result).toBe("fast-result");
  });

  it("uses DEFAULT_TOOL_CALL_TIMEOUT_MS when timeoutMs is undefined", async () => {
    const tool = makeTool("ok");
    const defaultDeps = makeDeps({ resolver: makeResolver(tool) });
    const frame = makeFrame();
    await handleToolCall(frame, defaultDeps);

    const sent = (defaultDeps.sendOutbound as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as NodeFrame;
    expect(sent.kind).toBe("tool_result");
  });

  it("passes AbortSignal to tool.execute via options", async () => {
    const tool: Tool = {
      descriptor: { name: "read_file", description: "Read a file", inputSchema: {} },
      trustTier: "sandbox",
      execute: mock((_args, options) => {
        // Verify signal is passed in options
        expect(options).toBeDefined();
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve("ok");
      }),
    };
    const signalDeps = makeDeps({ resolver: makeResolver(tool), timeoutMs: 5_000 });
    const frame = makeFrame();
    await handleToolCall(frame, signalDeps);

    expect(tool.execute).toHaveBeenCalledTimes(1);
    const sent = (signalDeps.sendOutbound as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as NodeFrame;
    expect(sent.kind).toBe("tool_result");
  });

  it("signal is aborted when timeout fires", async () => {
    // let justified: captured from inside the tool execute call
    let capturedSignal: AbortSignal | undefined;
    const slowTool: Tool = {
      descriptor: { name: "read_file", description: "Slow tool", inputSchema: {} },
      trustTier: "sandbox",
      execute: mock((_args, options) => {
        capturedSignal = options?.signal;
        return new Promise(() => {}); // never resolves
      }),
    };
    const timeoutDeps = makeDeps({
      resolver: makeResolver(slowTool),
      timeoutMs: 50,
    });
    const frame = makeFrame();
    await handleToolCall(frame, timeoutDeps);

    // After timeout, the signal should be aborted
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeWithSignal
// ---------------------------------------------------------------------------

describe("executeWithSignal", () => {
  it("cooperative tool that checks signal exits early", async () => {
    // let justified: step counter tracking cooperative cancellation
    let step = 0;
    const controller = new AbortController();
    const cooperativeTool: Tool = {
      descriptor: { name: "coop", description: "Cooperative tool", inputSchema: {} },
      trustTier: "sandbox",
      execute: async (_args, options) => {
        step = 1;
        // Simulate long work — signal fires before this completes
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (options?.signal?.aborted) {
          step = 2; // Reached cancellation check
          throw options.signal.reason;
        }
        step = 3; // Should not reach here
        return "completed";
      },
    };

    // Abort after 20ms — well before the 200ms work completes
    setTimeout(() => controller.abort(new Error("cancelled")), 20);

    await expect(executeWithSignal(cooperativeTool, {}, controller.signal)).rejects.toThrow(
      "cancelled",
    );
    // The backstop fires (at 20ms) before cooperative check (at 200ms),
    // so step remains 1 (the backstop rejects the race, tool is still sleeping)
    expect(step).toBe(1);
  });

  it("non-cooperating tool is still bounded by deadline", async () => {
    const hangingTool: Tool = {
      descriptor: { name: "hang", description: "Hanging tool", inputSchema: {} },
      trustTier: "sandbox",
      execute: () => new Promise(() => {}), // never resolves, ignores signal
    };

    const signal = AbortSignal.timeout(50);
    const start = Date.now();
    await expect(executeWithSignal(hangingTool, {}, signal)).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(300);
  });

  it("throws immediately when signal is already aborted", async () => {
    const tool = makeTool("should-not-reach");
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));

    await expect(executeWithSignal(tool, {}, controller.signal)).rejects.toThrow("pre-aborted");
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
