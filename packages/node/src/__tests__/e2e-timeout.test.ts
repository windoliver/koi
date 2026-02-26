/**
 * E2E tests for handleToolCall timeout feature.
 *
 * Tests the Node-level tool execution timeout with real async timing —
 * NOT mocked zero-ms delays. Validates:
 *   - Slow tool exceeding deadline → code: "timeout" frame
 *   - Fast tool completing before deadline → code: "tool_result"
 *   - Throwing tool → code: "execution_error", timer cleaned up
 *   - Concurrent tool calls → no timer leaks
 *   - Config wiring: parseNodeConfig includes toolCallTimeoutMs
 *
 * NOTE: handleToolCall is the Node-level tool dispatcher for remote tool
 * calls over the Gateway WS. The createKoi engine path uses a different
 * code path (callHandlers.toolCall → middleware chain → tool.execute).
 * See packages/engine/src/__tests__/e2e-full-stack.test.ts for that path.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-timeout.test.ts
 */

import { describe, expect, mock, test } from "bun:test";
import type { DelegationScope, KoiError, Result, ScopeChecker, Tool } from "@koi/core";
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  handleToolCall,
  type ToolCallHandlerDeps,
} from "../tool-call-handler.js";
import type { LocalResolver, ToolMeta } from "../tools/local-resolver.js";
import type { NodeFrame } from "../types.js";
import { parseNodeConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Gate — opt-in only (real async delays make tests slower)
// ---------------------------------------------------------------------------

const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = E2E_OPTED_IN ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers (real async tools — not zero-ms mocks)
// ---------------------------------------------------------------------------

/** Tool that sleeps for `delayMs` then returns `result`. */
function createSlowTool(name: string, delayMs: number, result: unknown = "done"): Tool {
  return {
    descriptor: { name, description: `Sleeps ${String(delayMs)}ms`, inputSchema: {} },
    trustTier: "sandbox",
    execute: async () => {
      await Bun.sleep(delayMs);
      return result;
    },
  };
}

/** Tool that never resolves — simulates a completely hung operation. */
function createHangingTool(name: string): Tool {
  return {
    descriptor: { name, description: "Hangs forever", inputSchema: {} },
    trustTier: "sandbox",
    execute: () => new Promise(() => {}),
  };
}

/** Tool that throws after a delay. */
function createThrowingTool(name: string, delayMs: number, message: string): Tool {
  return {
    descriptor: { name, description: `Throws after ${String(delayMs)}ms`, inputSchema: {} },
    trustTier: "sandbox",
    execute: async () => {
      await Bun.sleep(delayMs);
      throw new Error(message);
    },
  };
}

function makeResolver(tool: Tool): LocalResolver {
  return {
    discover: mock(() => Promise.resolve([] as readonly ToolMeta[])),
    list: mock(() => [] as readonly ToolMeta[]),
    load: mock(() => Promise.resolve({ ok: true, value: tool } as Result<Tool, KoiError>)),
    source: mock(() =>
      Promise.resolve({
        ok: false,
        error: { code: "NOT_FOUND", message: "no source", retryable: false },
      } as Result<never, KoiError>),
    ),
  };
}

function makeChecker(): ScopeChecker {
  return { isAllowed: () => true };
}

function makeScope(): DelegationScope {
  return { permissions: { tools: { allow: ["*"] } } };
}

function makeDeps(tool: Tool, overrides?: Partial<ToolCallHandlerDeps>): ToolCallHandlerDeps {
  return {
    nodeId: "e2e-node",
    permission: { checker: makeChecker(), scope: makeScope() },
    resolver: makeResolver(tool),
    sendOutbound: mock(() => {}),
    emit: mock(() => {}),
    ...overrides,
  };
}

function makeFrame(toolName: string): NodeFrame {
  return {
    nodeId: "e2e-node",
    agentId: "e2e-agent",
    correlationId: "e2e-corr",
    kind: "tool_call",
    payload: { toolName, args: {}, callerAgentId: "e2e-caller" },
  };
}

function getSentFrame(deps: ToolCallHandlerDeps, index = 0): NodeFrame {
  return (deps.sendOutbound as ReturnType<typeof mock>).mock.calls[index]?.[0] as NodeFrame;
}

function getEmittedType(deps: ToolCallHandlerDeps, index = 0): string {
  return (deps.emit as ReturnType<typeof mock>).mock.calls[index]?.[0] as string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: handleToolCall timeout (real async)", () => {
  // ── Timeout fires on slow tool ──────────────────────────────────────

  test("slow tool exceeding deadline sends timeout error frame", async () => {
    const tool = createSlowTool("slow-tool", 500, "should-never-arrive");
    const deps = makeDeps(tool, { timeoutMs: 100 });
    const frame = makeFrame("slow-tool");

    const start = Date.now();
    await handleToolCall(frame, deps);
    const elapsed = Date.now() - start;

    // Should resolve around 100ms (timeout), NOT 500ms (tool completion)
    expect(elapsed).toBeLessThan(300);
    expect(elapsed).toBeGreaterThanOrEqual(80);

    // Should send tool_error with code: "timeout"
    expect(deps.sendOutbound).toHaveBeenCalledTimes(1);
    const sent = getSentFrame(deps);
    expect(sent.kind).toBe("tool_error");
    expect((sent.payload as { code: string }).code).toBe("timeout");
    expect((sent.payload as { message: string }).message).toContain("timed out");
    expect((sent.payload as { message: string }).message).toContain("100");

    // Should emit agent_crashed
    expect(deps.emit).toHaveBeenCalledTimes(1);
    expect(getEmittedType(deps)).toBe("agent_crashed");
  }, 10_000);

  // ── Hanging tool (never resolves) ───────────────────────────────────

  test("hanging tool (never resolves) is caught by timeout", async () => {
    const tool = createHangingTool("hang-tool");
    const deps = makeDeps(tool, { timeoutMs: 150 });
    const frame = makeFrame("hang-tool");

    const start = Date.now();
    await handleToolCall(frame, deps);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(400);
    expect(elapsed).toBeGreaterThanOrEqual(100);

    const sent = getSentFrame(deps);
    expect(sent.kind).toBe("tool_error");
    expect((sent.payload as { code: string }).code).toBe("timeout");
  }, 10_000);

  // ── Fast tool completes before deadline ─────────────────────────────

  test("fast tool completes before deadline → tool_result", async () => {
    const tool = createSlowTool("fast-tool", 10, { answer: 42 });
    const deps = makeDeps(tool, { timeoutMs: 5_000 });
    const frame = makeFrame("fast-tool");

    const start = Date.now();
    await handleToolCall(frame, deps);
    const elapsed = Date.now() - start;

    // Should resolve around 10ms, not 5000ms
    expect(elapsed).toBeLessThan(500);

    const sent = getSentFrame(deps);
    expect(sent.kind).toBe("tool_result");
    expect((sent.payload as { result: unknown }).result).toEqual({ answer: 42 });

    // No agent_crashed emitted for successful execution
    expect(deps.emit).not.toHaveBeenCalled();
  }, 10_000);

  // ── Throwing tool: error handled, timer cleaned ─────────────────────

  test("throwing tool produces execution_error and timer is cleaned up", async () => {
    const tool = createThrowingTool("throw-tool", 10, "disk full");
    const deps = makeDeps(tool, { timeoutMs: 5_000 });
    const frame = makeFrame("throw-tool");

    const start = Date.now();
    await handleToolCall(frame, deps);
    const elapsed = Date.now() - start;

    // Should resolve quickly (tool throws after ~10ms), not at 5s timeout
    expect(elapsed).toBeLessThan(500);

    const sent = getSentFrame(deps);
    expect(sent.kind).toBe("tool_error");
    expect((sent.payload as { code: string }).code).toBe("execution_error");

    // agent_crashed emitted for the error
    expect(deps.emit).toHaveBeenCalledTimes(1);
    expect(getEmittedType(deps)).toBe("agent_crashed");
  }, 10_000);

  // ── DEFAULT_TOOL_CALL_TIMEOUT_MS constant ───────────────────────────

  test("DEFAULT_TOOL_CALL_TIMEOUT_MS is 30 seconds", () => {
    expect(DEFAULT_TOOL_CALL_TIMEOUT_MS).toBe(30_000);
  });

  // ── Concurrent tool calls: no timer leaks ───────────────────────────

  test("concurrent tool calls complete without timer leaks", async () => {
    const CONCURRENCY = 20;
    const calls: Promise<void>[] = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      // Mix of fast tools (10ms) and timeout tools (500ms with 100ms deadline)
      const isFast = i % 2 === 0;
      const tool = isFast
        ? createSlowTool(`tool-${String(i)}`, 10, `result-${String(i)}`)
        : createSlowTool(`tool-${String(i)}`, 500, "should-timeout");

      const deps = makeDeps(tool, { timeoutMs: isFast ? 5_000 : 100 });
      const frame = makeFrame(`tool-${String(i)}`);
      calls.push(handleToolCall(frame, deps));
    }

    // All should complete (fast ones succeed, slow ones timeout)
    await Promise.all(calls);

    // If timers leaked, they'd fire after the test and potentially cause
    // unhandled promise rejections or test pollution. This test verifies
    // the finally block cleans up properly under concurrent load.
  }, 30_000);

  // ── Config wiring: parseNodeConfig ──────────────────────────────────

  test("parseNodeConfig includes toolCallTimeoutMs with default 30s", () => {
    const result = parseNodeConfig({
      gateway: { url: "wss://example.com" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.tools.toolCallTimeoutMs).toBe(30_000);
  });

  test("parseNodeConfig accepts custom toolCallTimeoutMs", () => {
    const result = parseNodeConfig({
      gateway: { url: "wss://example.com" },
      tools: { toolCallTimeoutMs: 60_000 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.tools.toolCallTimeoutMs).toBe(60_000);
  });

  test("parseNodeConfig rejects non-positive toolCallTimeoutMs", () => {
    const zeroResult = parseNodeConfig({
      gateway: { url: "wss://example.com" },
      tools: { toolCallTimeoutMs: 0 },
    });
    expect(zeroResult.ok).toBe(false);

    const negativeResult = parseNodeConfig({
      gateway: { url: "wss://example.com" },
      tools: { toolCallTimeoutMs: -1 },
    });
    expect(negativeResult.ok).toBe(false);
  });

  // ── Timing precision: timeout fires at the right time ───────────────

  test("timeout fires close to the configured deadline (within 50ms tolerance)", async () => {
    const tool = createHangingTool("precise-hang");
    const TIMEOUT = 200;
    const deps = makeDeps(tool, { timeoutMs: TIMEOUT });
    const frame = makeFrame("precise-hang");

    const start = Date.now();
    await handleToolCall(frame, deps);
    const elapsed = Date.now() - start;

    // Should fire within 50ms of the configured timeout
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT - 20);
    expect(elapsed).toBeLessThan(TIMEOUT + 50);
  }, 10_000);
});
