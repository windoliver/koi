import { describe, expect, mock, test } from "bun:test";
import type { AuditEntry, AuditSink, CredentialComponent } from "@koi/core";
import { runId, sessionId } from "@koi/core";
import type { ToolExecutionContext } from "@koi/execution-context";
import { runWithExecutionContext } from "@koi/execution-context";
import { createAuditedCredentials } from "./audited-credentials.js";
import { createScopedCredentials } from "./scoped-credentials.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCredentials(store: Record<string, string> = {}): CredentialComponent {
  return {
    async get(key: string): Promise<string | undefined> {
      return store[key];
    },
  };
}

function createCaptureSink(): { readonly sink: AuditSink; readonly entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    sink: {
      log: async (entry: AuditEntry): Promise<void> => {
        entries.push(entry);
      },
    },
  };
}

function createTestContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    session: {
      agentId: "test-agent",
      sessionId: sessionId("test-session"),
      runId: runId("test-run"),
      metadata: {},
    },
    turnIndex: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAuditedCredentials", () => {
  test("logs kind 'secret_access' with granted: true on successful access", async () => {
    const { sink, entries } = createCaptureSink();
    const inner = createMockCredentials({ API_KEY: "supersecret" });
    const audited = createAuditedCredentials(inner, { sink });

    const result = await runWithExecutionContext(createTestContext(), () => audited.get("API_KEY"));

    expect(result).toBe("supersecret");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("secret_access");
    expect(entries[0]?.metadata).toMatchObject({ credentialKey: "API_KEY", granted: true });
  });

  test("logs kind 'secret_access' with granted: false when key not found", async () => {
    const { sink, entries } = createCaptureSink();
    const inner = createMockCredentials({});
    const audited = createAuditedCredentials(inner, { sink });

    const result = await runWithExecutionContext(createTestContext(), () =>
      audited.get("MISSING_KEY"),
    );

    expect(result).toBeUndefined();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("secret_access");
    expect(entries[0]?.metadata).toMatchObject({ credentialKey: "MISSING_KEY", granted: false });
  });

  test("metadata.credentialKey matches the requested key", async () => {
    const { sink, entries } = createCaptureSink();
    const inner = createMockCredentials({ MY_SECRET: "value" });
    const audited = createAuditedCredentials(inner, { sink });

    await runWithExecutionContext(createTestContext(), () => audited.get("MY_SECRET"));

    expect(entries[0]?.metadata).toMatchObject({ credentialKey: "MY_SECRET" });
  });

  test("secret value never appears in audit entry", async () => {
    const { sink, entries } = createCaptureSink();
    const secretValue = "super-secret-value-12345";
    const inner = createMockCredentials({ KEY: secretValue });
    const audited = createAuditedCredentials(inner, { sink });

    await runWithExecutionContext(createTestContext(), () => audited.get("KEY"));

    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain(secretValue);
  });

  test("captures agentId, sessionId, and turnIndex from execution context", async () => {
    const { sink, entries } = createCaptureSink();
    const inner = createMockCredentials({ K: "v" });
    const audited = createAuditedCredentials(inner, { sink });

    const ctx = createTestContext({
      session: {
        agentId: "agent-42",
        sessionId: sessionId("session-99"),
        runId: runId("run-1"),
        metadata: {},
      },
      turnIndex: 7,
    });

    await runWithExecutionContext(ctx, () => audited.get("K"));

    expect(entries[0]?.agentId).toBe("agent-42");
    expect(entries[0]?.sessionId).toBe("session-99");
    expect(entries[0]?.turnIndex).toBe(7);
  });

  test("falls back to 'unknown' / -1 without execution context", async () => {
    const { sink, entries } = createCaptureSink();
    const inner = createMockCredentials({ K: "v" });
    const audited = createAuditedCredentials(inner, { sink });

    // Call outside runWithExecutionContext
    await audited.get("K");

    expect(entries[0]?.agentId).toBe("unknown");
    expect(entries[0]?.sessionId).toBe("unknown");
    expect(entries[0]?.turnIndex).toBe(-1);
  });

  test("sink errors are swallowed — credential access still returns value", async () => {
    const failingSink: AuditSink = {
      log: async (): Promise<void> => {
        throw new Error("sink exploded");
      },
    };
    const inner = createMockCredentials({ KEY: "value" });
    const audited = createAuditedCredentials(inner, { sink: failingSink });

    const result = await audited.get("KEY");

    expect(result).toBe("value");
  });

  test("onError callback receives sink failures", async () => {
    const sinkError = new Error("sink failure");
    const failingSink: AuditSink = {
      log: async (): Promise<void> => {
        throw sinkError;
      },
    };
    const onError = mock((_error: unknown, _entry: AuditEntry) => {});
    const inner = createMockCredentials({ KEY: "value" });
    const audited = createAuditedCredentials(inner, { sink: failingSink, onError });

    await audited.get("KEY");

    // Give the fire-and-forget promise time to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(sinkError);
    expect(onError.mock.calls[0]?.[1]).toHaveProperty("kind", "secret_access");
  });

  test("onError callback that throws does not cause unhandled rejection", async () => {
    const failingSink: AuditSink = {
      log: async (): Promise<void> => {
        throw new Error("sink failure");
      },
    };
    const throwingOnError = (): void => {
      throw new Error("onError itself exploded");
    };
    const inner = createMockCredentials({ KEY: "value" });
    const audited = createAuditedCredentials(inner, {
      sink: failingSink,
      onError: throwingOnError,
    });

    // Should not throw or cause unhandled rejection
    const result = await audited.get("KEY");
    expect(result).toBe("value");

    // Give fire-and-forget promise time to settle
    await new Promise((resolve) => setTimeout(resolve, 10));
    // If we reach here without process crash, the test passes
  });

  test("duration is measured (>= 0)", async () => {
    const { sink, entries } = createCaptureSink();
    const inner = createMockCredentials({ K: "v" });
    const audited = createAuditedCredentials(inner, { sink });

    await audited.get("K");

    expect(entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("composes correctly with createScopedCredentials", async () => {
    const { sink, entries } = createCaptureSink();
    const inner = createMockCredentials({ API_KEY: "secret", DB_PASS: "dbsecret" });
    const scoped = createScopedCredentials(inner, { keyPattern: "API_*" });
    const audited = createAuditedCredentials(scoped, { sink });

    // Allowed key
    const result1 = await audited.get("API_KEY");
    expect(result1).toBe("secret");
    expect(entries[0]?.metadata).toMatchObject({ credentialKey: "API_KEY", granted: true });

    // Denied key (filtered by scope)
    const result2 = await audited.get("DB_PASS");
    expect(result2).toBeUndefined();
    expect(entries[1]?.metadata).toMatchObject({ credentialKey: "DB_PASS", granted: false });
  });
});
