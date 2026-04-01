import { describe, expect, it } from "bun:test";
import type { SessionContext } from "@koi/core";
import { runId, sessionId } from "@koi/core";
import { runWithExecutionContext } from "@koi/execution-context";
import { createShellTool } from "./shell.js";

describe("shell tool", () => {
  it("has correct descriptor", () => {
    const tool = createShellTool();
    expect(tool.descriptor.name).toBe("shell");
    expect(tool.policy.sandbox).toBe(true);
  });

  it("executes a simple command", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "echo hello" })) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "echo error >&2" })) as {
      stderr: string;
      exitCode: number;
    };
    expect(result.stderr.trim()).toBe("error");
  });

  it("returns non-zero exit code", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "exit 42" })) as { exitCode: number };
    expect(result.exitCode).toBe(42);
  });

  it("times out long commands", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({
      command: "sleep 10",
      timeoutMs: 100,
    })) as { error: string; timedOut: boolean };
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  });

  it("rejects empty command", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "" })) as { error: string };
    expect(result.error).toContain("non-empty string");
  });

  it("rejects missing command", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({})) as { error: string };
    expect(result.error).toContain("non-empty string");
  });

  it("respects custom cwd", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "pwd", cwd: "/tmp" })) as {
      stdout: string;
    };
    expect(result.stdout.trim()).toContain("tmp");
  });
});

// ---------------------------------------------------------------------------
// Signal-based cooperative cancellation
// ---------------------------------------------------------------------------

describe("shell tool signal cancellation", () => {
  it("returns cancelled result when signal already aborted", async () => {
    const tool = createShellTool();
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));

    const result = (await tool.execute(
      { command: "echo hello" },
      { signal: controller.signal },
    )) as {
      error: string;
      cancelled: boolean;
    };
    expect(result.cancelled).toBe(true);
    expect(result.error).toContain("cancelled");
  });

  it("kills process when signal aborts during execution", async () => {
    const tool = createShellTool();
    const controller = new AbortController();

    // Abort after 100ms — command sleeps for 10s
    setTimeout(() => controller.abort(new Error("cancelled")), 100);

    const start = Date.now();
    await tool.execute({ command: "sleep 10", timeoutMs: 30_000 }, { signal: controller.signal });
    const elapsed = Date.now() - start;

    // Should complete well before the 10s sleep or 30s timeout
    expect(elapsed).toBeLessThan(5_000);
    // Process was killed — either via signal abort handler or timeout check
    // The exact result depends on timing, but it should not take 10 seconds
  });

  it("prefers signal-based cancellation over internal timeout when signal provided", async () => {
    const tool = createShellTool();
    const signal = AbortSignal.timeout(100);

    const start = Date.now();
    await tool.execute({ command: "sleep 10", timeoutMs: 30_000 }, { signal });
    const elapsed = Date.now() - start;

    // Signal should cancel well before the 30s internal timeout
    expect(elapsed).toBeLessThan(5_000);
  });

  it("falls back to internal timeout when no signal provided", async () => {
    const tool = createShellTool();

    const start = Date.now();
    const result = (await tool.execute({ command: "sleep 10", timeoutMs: 100 })) as {
      error: string;
      timedOut: boolean;
    };
    const elapsed = Date.now() - start;

    // Internal timeout should fire at ~100ms
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
    expect(elapsed).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// KOI_* env var injection
// ---------------------------------------------------------------------------

describe("shell tool KOI_* env injection", () => {
  function createTestSession(overrides?: Partial<SessionContext>): SessionContext {
    return {
      agentId: "agent-shell-test",
      sessionId: sessionId("sess-shell-test"),
      runId: runId("run-shell-test"),
      metadata: {},
      ...overrides,
    };
  }

  it("without execution context only has SAFE_ENV_KEYS (backwards compatible)", async () => {
    const tool = createShellTool();
    const result = (await tool.execute({ command: "env" })) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.exitCode).toBe(0);
    // KOI_* vars should NOT be present
    expect(result.stdout).not.toContain("KOI_AGENT_ID");
    expect(result.stdout).not.toContain("KOI_SESSION_ID");
  });

  it("within execution context includes KOI_* vars in child env", async () => {
    const tool = createShellTool();
    const ctx = {
      session: createTestSession({
        userId: "user-99",
        channelId: "@koi/channel-slack",
      }),
      turnIndex: 7,
    };

    const result = (await runWithExecutionContext(ctx, () => tool.execute({ command: "env" }))) as {
      stdout: string;
      exitCode: number;
    };

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("KOI_AGENT_ID=agent-shell-test");
    expect(result.stdout).toContain("KOI_SESSION_ID=sess-shell-test");
    expect(result.stdout).toContain("KOI_RUN_ID=run-shell-test");
    expect(result.stdout).toContain("KOI_USER_ID=user-99");
    expect(result.stdout).toContain("KOI_CHANNEL=@koi/channel-slack");
    expect(result.stdout).toContain("KOI_TURN_INDEX=7");
  });

  it("child process can echo $KOI_AGENT_ID and get correct value", async () => {
    const tool = createShellTool();
    const ctx = {
      session: createTestSession(),
      turnIndex: 0,
    };

    const result = (await runWithExecutionContext(ctx, () =>
      tool.execute({ command: "echo $KOI_AGENT_ID" }),
    )) as { stdout: string; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("agent-shell-test");
  });

  it("KOI_USER_ID is absent when userId not in context", async () => {
    const tool = createShellTool();
    const ctx = {
      session: createTestSession(),
      turnIndex: 0,
    };

    const result = (await runWithExecutionContext(ctx, () => tool.execute({ command: "env" }))) as {
      stdout: string;
      exitCode: number;
    };

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("KOI_USER_ID");
  });

  it("KOI_CHANNEL is absent when channelId not in context", async () => {
    const tool = createShellTool();
    const ctx = {
      session: createTestSession(),
      turnIndex: 0,
    };

    const result = (await runWithExecutionContext(ctx, () => tool.execute({ command: "env" }))) as {
      stdout: string;
      exitCode: number;
    };

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("KOI_CHANNEL");
  });
});
