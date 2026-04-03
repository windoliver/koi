/**
 * E2E integration tests for agent hook lifecycle.
 *
 * Tests the full path: hook config → loadHooks → createHookMiddleware →
 * registry → executor → SpawnFn → verdict parsing → decision → middleware action.
 *
 * Uses a mock SpawnFn that simulates agent behavior (no real LLM).
 */

import { describe, expect, it, mock } from "bun:test";
import type {
  RunId,
  SessionContext,
  SessionId,
  SpawnFn,
  SpawnRequest,
  SpawnResult,
  ToolRequest,
  ToolResponse,
  TurnContext,
  TurnId,
} from "@koi/core";
import { loadHooks } from "../loader.js";
import { createHookMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSessionCtx(): SessionContext {
  return {
    agentId: "agent-1",
    sessionId: "session-e2e" as SessionId,
    runId: "run-1" as RunId,
    metadata: {},
  };
}

function makeTurnCtx(session?: SessionContext): TurnContext {
  return {
    session: session ?? makeSessionCtx(),
    turnIndex: 0,
    turnId: "turn-1" as TurnId,
    messages: [],
    metadata: {},
  };
}

function makeVerdictOutput(ok: boolean, reason?: string): string {
  return JSON.stringify({ ok, reason });
}

/**
 * Creates a SpawnFn that records requests and returns a configurable verdict.
 */
function createMockSpawnFn(verdict: { ok: boolean; reason?: string }): {
  spawnFn: SpawnFn;
  requests: SpawnRequest[];
} {
  const requests: SpawnRequest[] = [];
  const spawnFn: SpawnFn = async (request: SpawnRequest): Promise<SpawnResult> => {
    requests.push(request);
    return { ok: true, output: makeVerdictOutput(verdict.ok, verdict.reason) };
  };
  return { spawnFn, requests };
}

// ---------------------------------------------------------------------------
// Full lifecycle: config → load → middleware → dispatch → verdict → decision
// ---------------------------------------------------------------------------

describe("agent hook E2E lifecycle", () => {
  it("loads agent hook config, spawns sub-agent, and returns continue on ok=true", async () => {
    // 1. Load hook config
    const raw = [
      {
        kind: "agent",
        name: "security-reviewer",
        prompt: "Check for dangerous commands",
        filter: { events: ["tool.before"] },
      },
    ];
    const loaded = loadHooks(raw);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // 2. Create middleware with mock SpawnFn
    const { spawnFn, requests } = createMockSpawnFn({ ok: true });
    const mw = createHookMiddleware({ hooks: loaded.value, spawnFn });

    // 3. Start session
    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    // 4. Wrap a tool call — should trigger the agent hook
    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "file written",
    });
    const result = await mw.wrapToolCall?.(
      makeTurnCtx(ctx),
      { toolId: "Write", input: { path: "/etc/passwd" } },
      nextFn,
    );

    // 5. Verify: agent was spawned
    expect(requests.length).toBeGreaterThanOrEqual(1);
    const spawnReq = requests[0];
    expect(spawnReq?.agentName).toBe("hook-agent:security-reviewer");
    expect(spawnReq?.nonInteractive).toBe(true);

    // 6. Verify: tool call proceeded (verdict was ok=true → continue)
    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(result?.output).toBe("file written");

    // 7. Cleanup
    await mw.onSessionEnd?.(ctx);
  });

  it("blocks tool call when agent hook returns ok=false", async () => {
    const raw = [
      {
        kind: "agent",
        name: "safety-gate",
        prompt: "Block dangerous operations",
        filter: { events: ["tool.before"] },
      },
    ];
    const loaded = loadHooks(raw);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const { spawnFn } = createMockSpawnFn({ ok: false, reason: "rm -rf detected" });
    const mw = createHookMiddleware({ hooks: loaded.value, spawnFn });

    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "should not reach",
    });
    const result = await mw.wrapToolCall?.(
      makeTurnCtx(ctx),
      { toolId: "Bash", input: { cmd: "rm -rf /" } },
      nextFn,
    );

    // Tool call should be blocked
    expect(nextFn).not.toHaveBeenCalled();
    expect(result?.output).toEqual({ error: expect.stringContaining("rm -rf detected") });

    await mw.onSessionEnd?.(ctx);
  });

  it("blocks when spawn fails and failClosed=true (default for agent)", async () => {
    const raw = [
      {
        kind: "agent",
        name: "fail-test",
        prompt: "This will fail",
        filter: { events: ["tool.before"] },
      },
    ];
    const loaded = loadHooks(raw);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // SpawnFn that always fails
    const spawnFn: SpawnFn = async () => ({
      ok: false,
      error: { code: "INTERNAL", message: "spawn crashed", retryable: false },
    });
    const mw = createHookMiddleware({ hooks: loaded.value, spawnFn });

    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "nope",
    });
    const result = await mw.wrapToolCall?.(makeTurnCtx(ctx), { toolId: "Bash", input: {} }, nextFn);

    // Fail-closed: tool call blocked
    expect(nextFn).not.toHaveBeenCalled();
    expect(result?.output).toEqual({ error: expect.stringContaining("spawn crashed") });

    await mw.onSessionEnd?.(ctx);
  });

  it("passes HookVerdict tool and denylist in SpawnRequest", async () => {
    const raw = [
      {
        kind: "agent",
        name: "tool-check",
        prompt: "Verify tool usage",
        toolDenylist: ["Bash"],
        filter: { events: ["tool.before"] },
      },
    ];
    const loaded = loadHooks(raw);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const { spawnFn, requests } = createMockSpawnFn({ ok: true });
    const mw = createHookMiddleware({ hooks: loaded.value, spawnFn });

    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "ok",
    });
    await mw.wrapToolCall?.(makeTurnCtx(ctx), { toolId: "Edit", input: {} }, nextFn);

    // Verify spawn request includes HookVerdict tool and merged denylist
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req).toBeDefined();
    if (req === undefined) return;
    const toolNames = req.additionalTools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("HookVerdict");
    expect(req.toolDenylist).toContain("spawn");
    expect(req.toolDenylist).toContain("agent");
    expect(req.toolDenylist).toContain("Bash");
    expect(req.maxTurns).toBe(10); // default
    expect(req.maxTokens).toBe(4096); // default

    await mw.onSessionEnd?.(ctx);
  });

  it("agent + command hooks coexist — both fire on matching events", async () => {
    const raw = [
      {
        kind: "command",
        name: "audit-log",
        cmd: ["echo", "logged"],
        filter: { events: ["tool.before"] },
      },
      {
        kind: "agent",
        name: "verify",
        prompt: "Check safety",
        filter: { events: ["tool.before"] },
      },
    ];
    const loaded = loadHooks(raw);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const { spawnFn, requests } = createMockSpawnFn({ ok: true });
    const mw = createHookMiddleware({ hooks: loaded.value, spawnFn });

    const ctx = makeSessionCtx();
    await mw.onSessionStart?.(ctx);

    const nextFn = mock<(req: ToolRequest) => Promise<ToolResponse>>().mockResolvedValue({
      output: "done",
    });
    await mw.wrapToolCall?.(makeTurnCtx(ctx), { toolId: "Read", input: {} }, nextFn);

    // Agent hook was invoked
    expect(requests).toHaveLength(1);
    // Tool call proceeded (both hooks said continue)
    expect(nextFn).toHaveBeenCalledTimes(1);

    await mw.onSessionEnd?.(ctx);
  });
});
