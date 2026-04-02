import { describe, expect, it, mock } from "bun:test";
import type { AgentHookConfig, HookEvent, SpawnFn, SpawnResult } from "@koi/core";
import { AgentHookExecutor, createAgentExecutor, mergeToolDenylist } from "./agent-executor.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseEvent: HookEvent = {
  event: "tool.before",
  agentId: "agent-1",
  sessionId: "session-1",
  toolName: "Bash",
  data: { input: { cmd: "rm -rf /" } },
};

const baseHook: AgentHookConfig = {
  kind: "agent",
  name: "security-check",
  prompt: "Check for dangerous commands",
};

function makeSpawnFn(result: SpawnResult): SpawnFn {
  return mock<SpawnFn>().mockResolvedValue(result);
}

function makeVerdictOutput(ok: boolean, reason?: string): string {
  return JSON.stringify({ ok, reason });
}

// ---------------------------------------------------------------------------
// createAgentExecutor factory
// ---------------------------------------------------------------------------

describe("createAgentExecutor", () => {
  it("returns an AgentHookExecutor instance", () => {
    const executor = createAgentExecutor({ spawnFn: makeSpawnFn({ ok: true, output: "" }) });
    expect(executor).toBeInstanceOf(AgentHookExecutor);
    expect(executor.name).toBe("agent");
  });

  it("canHandle returns true for agent hooks", () => {
    const executor = createAgentExecutor({ spawnFn: makeSpawnFn({ ok: true, output: "" }) });
    expect(executor.canHandle(baseHook)).toBe(true);
  });

  it("canHandle returns false for command hooks", () => {
    const executor = createAgentExecutor({ spawnFn: makeSpawnFn({ ok: true, output: "" }) });
    expect(executor.canHandle({ kind: "command", name: "t", cmd: ["echo"] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Happy path — verdict parsing
// ---------------------------------------------------------------------------

describe("agent executor verdict parsing", () => {
  it("returns continue when agent verdicts ok=true", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toEqual({ kind: "continue" });
    }
  });

  it("returns block when agent verdicts ok=false with reason", async () => {
    const spawnFn = makeSpawnFn({
      ok: true,
      output: makeVerdictOutput(false, "dangerous command"),
    });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toEqual({ kind: "block", reason: "dangerous command" });
    }
  });

  it("measures durationMs > 0", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("passes hook name through to result", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(result.hookName).toBe("security-check");
  });
});

// ---------------------------------------------------------------------------
// Stop guard adversarial scenarios (Decision 3A / Issue 11A)
// ---------------------------------------------------------------------------

describe("stop guard — invalid verdict handling", () => {
  it("blocks (fail-closed) when agent produces no verdict output", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: "" });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("block");
      if (result.decision.kind === "block") {
        expect(result.decision.reason).toContain("valid HookVerdict");
      }
    }
  });

  it("blocks (fail-closed) when agent produces non-JSON text", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: "I checked and it looks fine." });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("block");
    }
  });

  it("blocks (fail-closed) when agent produces JSON without ok field", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: JSON.stringify({ reason: "fine" }) });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("block");
    }
  });

  it("continues (fail-open) when agent produces no verdict and failClosed=false", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: "" });
    const hook: AgentHookConfig = { ...baseHook, failClosed: false };
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toEqual({ kind: "continue" });
    }
  });
});

// ---------------------------------------------------------------------------
// Fail mode handling (Decision 4A)
// ---------------------------------------------------------------------------

describe("fail mode", () => {
  it("blocks on spawn failure when failClosed=true (default)", async () => {
    const spawnFn = makeSpawnFn({
      ok: false,
      error: { code: "INTERNAL", message: "agent crashed", retryable: false },
    });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("block");
      if (result.decision.kind === "block") {
        expect(result.decision.reason).toContain("agent crashed");
      }
    }
  });

  it("continues on spawn failure when failClosed=false", async () => {
    const spawnFn = makeSpawnFn({
      ok: false,
      error: { code: "INTERNAL", message: "agent crashed", retryable: false },
    });
    const hook: AgentHookConfig = { ...baseHook, failClosed: false };
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toEqual({ kind: "continue" });
    }
  });
});

// ---------------------------------------------------------------------------
// Token accounting (Decision 14A)
// ---------------------------------------------------------------------------

describe("token accounting", () => {
  it("reserves worst-case tokens (maxTurns * maxTokens) per invocation", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    const executor = createAgentExecutor({ spawnFn });

    expect(executor.getSessionTokens("session-1")).toBe(0);

    // Default: maxTurns=10 * maxTokens=4096 = 40,960 per invocation
    await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(executor.getSessionTokens("session-1")).toBe(40_960);
  });

  it("respects custom maxTokens and maxTurns for accounting", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    const hook: AgentHookConfig = { ...baseHook, maxTokens: 1000, maxTurns: 3 };
    const executor = createAgentExecutor({ spawnFn });

    // 3 turns * 1000 tokens = 3000 reserved
    await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));
    expect(executor.getSessionTokens("session-1")).toBe(3000);
  });

  it("blocks when worst-case reservation exceeds budget (fail-closed)", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    // Budget 5000, each invocation reserves 2 turns * 2000 = 4000
    const hook: AgentHookConfig = {
      ...baseHook,
      maxSessionTokens: 5000,
      maxTokens: 2000,
      maxTurns: 2,
    };
    const executor = createAgentExecutor({ spawnFn });

    // First call: reserves 4000, under 5000 budget
    await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));
    expect(executor.getSessionTokens("session-1")).toBe(4000);

    // Second call: 4000 + 4000 = 8000 > 5000, should be blocked
    const result = await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("block");
      if (result.decision.kind === "block") {
        expect(result.decision.reason).toContain("budget exhausted");
      }
    }
    // spawnFn should NOT have been called for the blocked invocation
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("continues when session token budget exhausted with failClosed=false", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    // Budget 5000, each invocation reserves 2 * 2000 = 4000
    const hook: AgentHookConfig = {
      ...baseHook,
      maxSessionTokens: 5000,
      maxTokens: 2000,
      maxTurns: 2,
      failClosed: false,
    };
    const executor = createAgentExecutor({ spawnFn });

    // First call: reserves 4000, under 5000 budget
    await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));
    expect(executor.getSessionTokens("session-1")).toBe(4000);

    // Second call: 4000 + 4000 > 5000 → budget exhausted, failClosed=false → continue
    const result = await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toEqual({ kind: "continue" });
    }
  });

  it("cleans up session tokens", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    const executor = createAgentExecutor({ spawnFn });

    await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(executor.getSessionTokens("session-1")).toBeGreaterThan(0);

    executor.cleanupSession("session-1");
    expect(executor.getSessionTokens("session-1")).toBe(0);
  });

  it("tracks tokens even on failure", async () => {
    const spawnFn = makeSpawnFn({
      ok: false,
      error: { code: "INTERNAL", message: "crash", retryable: false },
    });
    const executor = createAgentExecutor({ spawnFn });

    await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));
    expect(executor.getSessionTokens("session-1")).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Spawn request construction
// ---------------------------------------------------------------------------

describe("spawn request", () => {
  it("puts hook prompt in systemPrompt and event data in description", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const executor = createAgentExecutor({ spawnFn });

    await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // Hook policy in systemPrompt (trusted level)
    expect(request.systemPrompt).toContain("Check for dangerous commands");
    // Event data in description (user level, framed as untrusted)
    expect(request.description).toContain("tool.before");
    expect(request.description).toContain("UNTRUSTED INPUT");
    // Hook prompt NOT in description
    expect(request.description).not.toContain("Check for dangerous commands");
    expect(request.agentName).toBe("hook-agent:security-check");
  });

  it("passes nonInteractive, systemPrompt, maxTurns, maxTokens", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const executor = createAgentExecutor({ spawnFn });

    await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(request.nonInteractive).toBe(true);
    expect(request.systemPrompt).toContain("verification agent");
    expect(request.maxTurns).toBe(10); // DEFAULT_AGENT_MAX_TURNS
    expect(request.maxTokens).toBe(4096); // DEFAULT_AGENT_MAX_TOKENS
  });

  it("passes HookVerdict tool in additionalTools", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const executor = createAgentExecutor({ spawnFn });

    await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const tools = request.additionalTools as ReadonlyArray<{ name: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("HookVerdict");
  });

  it("passes merged tool denylist", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const hook: AgentHookConfig = { ...baseHook, toolDenylist: ["Bash"] };
    const executor = createAgentExecutor({ spawnFn });

    await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const denylist = request.toolDenylist as string[];
    expect(denylist).toContain("spawn");
    expect(denylist).toContain("agent");
    expect(denylist).toContain("Bash");
  });

  it("passes custom systemPrompt and maxTurns from hook config", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const hook: AgentHookConfig = {
      ...baseHook,
      systemPrompt: "You are a code reviewer.",
      maxTurns: 3,
      maxTokens: 2048,
    };
    const executor = createAgentExecutor({ spawnFn });

    await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // Custom system prompt is composed with hook policy
    expect(request.systemPrompt).toContain("You are a code reviewer.");
    expect(request.maxTurns).toBe(3);
    expect(request.maxTokens).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// Payload redaction (Issue #1323)
// ---------------------------------------------------------------------------

describe("payload redaction", () => {
  it("forwards structure-only payload by default (no raw values)", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const executor = createAgentExecutor({ spawnFn });

    await executor.execute(baseHook, baseEvent, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const description = request.description as string;
    // Should NOT contain the actual command value
    expect(description).not.toContain("rm -rf /");
    // Should contain structure placeholders
    expect(description).toContain("<string:");
    // Should contain structure-only note
    expect(description).toContain("structure only");
  });

  it("forwards redacted payload when forwardRawPayload is true", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const executor = createAgentExecutor({ spawnFn });
    const hook: AgentHookConfig = { ...baseHook, forwardRawPayload: true };

    await executor.execute(hook, baseEvent, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const description = request.description as string;
    // Safe non-secret data should be present
    expect(description).toContain("rm -rf /");
    // Should contain redaction note
    expect(description).toContain("secrets have been redacted");
  });

  it("redacts secrets in raw payload mode", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const executor = createAgentExecutor({ spawnFn });
    const hook: AgentHookConfig = { ...baseHook, forwardRawPayload: true };
    const event: HookEvent = {
      ...baseEvent,
      data: { password: "supersecret123", username: "alice" },
    };

    await executor.execute(hook, event, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const description = request.description as string;
    // Password field should be redacted
    expect(description).not.toContain("supersecret123");
    expect(description).toContain("[REDACTED]");
    // Non-secret field should be preserved
    expect(description).toContain("alice");
  });

  it("forwards unredacted payload when forwardRawPayload=true and redaction.enabled=false", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const executor = createAgentExecutor({ spawnFn });
    const hook: AgentHookConfig = {
      ...baseHook,
      forwardRawPayload: true,
      redaction: { enabled: false },
    };
    const event: HookEvent = {
      ...baseEvent,
      data: { password: "supersecret123" },
    };

    await executor.execute(hook, event, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const description = request.description as string;
    // With redaction disabled, raw value should be present
    expect(description).toContain("supersecret123");
  });

  it("redacts custom sensitiveFields in raw payload mode", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const executor = createAgentExecutor({ spawnFn });
    const hook: AgentHookConfig = {
      ...baseHook,
      forwardRawPayload: true,
      redaction: { sensitiveFields: ["tenantSecret"] },
    };
    const event: HookEvent = {
      ...baseEvent,
      data: { tenantSecret: "my-tenant-key", name: "acme" },
    };

    await executor.execute(hook, event, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const description = request.description as string;
    // Custom field should be redacted
    expect(description).not.toContain("my-tenant-key");
    expect(description).toContain("[REDACTED]");
    // Non-sensitive field should be preserved
    expect(description).toContain("acme");
  });

  it("falls back to structure for oversized raw payloads", async () => {
    const spawnFn = mock<SpawnFn>().mockResolvedValue({
      ok: true,
      output: makeVerdictOutput(true),
    });
    const executor = createAgentExecutor({ spawnFn });
    const hook: AgentHookConfig = { ...baseHook, forwardRawPayload: true };
    const event: HookEvent = {
      ...baseEvent,
      data: { content: "x".repeat(40_000), name: "test" },
    };

    await executor.execute(hook, event, AbortSignal.timeout(5000));

    const request = (spawnFn as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const description = request.description as string;
    // Should not contain the 40KB string
    expect(description).not.toContain("x".repeat(40_000));
    // Should contain structure placeholders from fallback
    expect(description).toContain("<string:");
  });
});

// ---------------------------------------------------------------------------
// Abort signal handling
// ---------------------------------------------------------------------------

describe("abort signal", () => {
  it("blocks (fail-closed) when already aborted", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(baseHook, baseEvent, AbortSignal.abort());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.kind).toBe("block");
    }
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("continues when already aborted with failClosed=false", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: makeVerdictOutput(true) });
    const hook: AgentHookConfig = { ...baseHook, failClosed: false };
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(hook, baseEvent, AbortSignal.abort());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision).toEqual({ kind: "continue" });
    }
  });
});

// ---------------------------------------------------------------------------
// Non-agent hook rejection
// ---------------------------------------------------------------------------

describe("non-agent hook", () => {
  it("returns error for command hook", async () => {
    const spawnFn = makeSpawnFn({ ok: true, output: "" });
    const executor = createAgentExecutor({ spawnFn });

    const result = await executor.execute(
      { kind: "command", name: "cmd", cmd: ["echo"] },
      baseEvent,
      AbortSignal.timeout(5000),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Not an agent hook");
    }
  });
});

// ---------------------------------------------------------------------------
// mergeToolDenylist
// ---------------------------------------------------------------------------

describe("mergeToolDenylist", () => {
  it("returns default denylist with read-only-by-default tools", () => {
    const result = mergeToolDenylist(undefined);
    // Recursion prevention
    expect(result.has("spawn")).toBe(true);
    expect(result.has("agent")).toBe(true);
    expect(result.has("Agent")).toBe(true);
    // Write/execute tools denied by default
    expect(result.has("Bash")).toBe(true);
    expect(result.has("Write")).toBe(true);
    expect(result.has("Edit")).toBe(true);
    expect(result.has("NotebookEdit")).toBe(true);
    // Verdict namespace reserved
    expect(result.has("HookVerdict")).toBe(true);
  });

  it("returns default denylist for empty array", () => {
    const result = mergeToolDenylist([]);
    expect(result.has("spawn")).toBe(true);
    expect(result.has("Bash")).toBe(true);
  });

  it("merges user denylist with defaults", () => {
    const result = mergeToolDenylist(["WebFetch", "custom"]);
    expect(result.has("spawn")).toBe(true);
    expect(result.has("Bash")).toBe(true);
    expect(result.has("WebFetch")).toBe(true);
    expect(result.has("custom")).toBe(true);
  });

  it("handles duplicates gracefully", () => {
    const result = mergeToolDenylist(["spawn", "custom"]);
    expect(result.has("spawn")).toBe(true);
    expect(result.has("custom")).toBe(true);
    // 8 defaults + 1 new "custom" = 9 (spawn is a dupe of default)
    expect(result.size).toBe(9);
  });
});
