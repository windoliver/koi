import { afterEach, describe, expect, mock, test } from "bun:test";
import type { JsonObject } from "@koi/core/common";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { PermissionBackend, PermissionDecision } from "@koi/core/permission-backend";
import type { ApprovalStore } from "../approval-store.js";
import { createApprovalStore } from "../approval-store.js";
import { createPermissionsMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// let: stores accumulate across tests and are cleaned up in afterEach
let stores: ApprovalStore[] = [];

function makeStore(): ApprovalStore {
  const store = createApprovalStore({ dbPath: ":memory:" });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const s of stores) {
    s.close();
  }
  stores = [];
});

function makeTurnContext(overrides?: {
  readonly userId?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly turnIndex?: number;
  readonly requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}): TurnContext {
  const base = {
    session: {
      agentId: overrides?.agentId ?? "agent:test",
      sessionId: (overrides?.sessionId ?? "s-1") as never,
      runId: "r-1" as never,
      userId: overrides?.userId ?? "user-1",
      metadata: {},
    },
    turnIndex: overrides?.turnIndex ?? 0,
    turnId: "t-1" as never,
    messages: [] as const,
    metadata: {},
  };
  if (overrides?.requestApproval !== undefined) {
    return { ...base, requestApproval: overrides.requestApproval };
  }
  return base;
}

function makeToolRequest(toolId: string, input: JsonObject = {}): ToolRequest {
  return { toolId, input };
}

const noopToolHandler = async (_req: ToolRequest): Promise<ToolResponse> => ({
  output: "done",
});

function askBackend(): PermissionBackend {
  return { check: (): PermissionDecision => ({ effect: "ask", reason: "needs approval" }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("persistent approval — middleware integration", () => {
  test("persistent grant short-circuits approval prompt", async () => {
    const store = makeStore();
    store.grant("user-1", "agent:test", "bash", Date.now());

    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "allow" }));
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: store,
    });
    const ctx = makeTurnContext({ requestApproval: approvalHandler });
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    expect(result?.output).toBe("done");
    // The approval handler should NOT have been called
    expect(approvalHandler).not.toHaveBeenCalled();
  });

  test("scope 'always' writes to persistent store", async () => {
    const store = makeStore();
    const approvalHandler = mock(
      async (): Promise<ApprovalDecision> => ({ kind: "always-allow", scope: "always" }),
    );
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: store,
    });
    const ctx = makeTurnContext({ requestApproval: approvalHandler });
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    expect(store.has("user-1", "agent:test", "bash")).toBe(true);
  });

  test("scope 'session' does NOT write to persistent store", async () => {
    const store = makeStore();
    const approvalHandler = mock(
      async (): Promise<ApprovalDecision> => ({ kind: "always-allow", scope: "session" }),
    );
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: store,
    });
    const ctx = makeTurnContext({ requestApproval: approvalHandler });
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    expect(store.has("user-1", "agent:test", "bash")).toBe(false);
  });

  test("persistent grant survives clearSessionApprovals", async () => {
    const store = makeStore();
    store.grant("user-1", "agent:test", "bash", Date.now());

    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: store,
    });
    mw.clearSessionApprovals("s-1");

    // Grant should still be in the persistent store
    expect(store.has("user-1", "agent:test", "bash")).toBe(true);

    // And middleware should still use it
    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "allow" }));
    const ctx = makeTurnContext({ requestApproval: approvalHandler });
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);
    expect(approvalHandler).not.toHaveBeenCalled();
  });

  test("middleware works identically when persistentApprovals is undefined", async () => {
    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "allow" }));
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
    });
    const ctx = makeTurnContext({ requestApproval: approvalHandler });
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    expect(result?.output).toBe("done");
    expect(approvalHandler).toHaveBeenCalledTimes(1);
  });

  test("store error on has() falls through to prompt (fail-open)", async () => {
    const brokenStore: ApprovalStore = {
      has(): boolean {
        throw new Error("SQLITE_CORRUPT");
      },
      grant(): void {},
      revoke(): boolean {
        return false;
      },
      revokeAll(): void {},
      list(): readonly never[] {
        return [];
      },
      close(): void {},
    };

    const approvalHandler = mock(async (): Promise<ApprovalDecision> => ({ kind: "allow" }));
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: brokenStore,
    });
    const ctx = makeTurnContext({ requestApproval: approvalHandler });
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    // Should fall through to approval handler despite store error
    expect(result?.output).toBe("done");
    expect(approvalHandler).toHaveBeenCalledTimes(1);
  });

  test("store error on grant() still executes tool (fail-safe)", async () => {
    const brokenStore: ApprovalStore = {
      has(): boolean {
        return false;
      },
      grant(): void {
        throw new Error("SQLITE_READONLY");
      },
      revoke(): boolean {
        return false;
      },
      revokeAll(): void {},
      list(): readonly never[] {
        return [];
      },
      close(): void {},
    };

    const approvalHandler = mock(
      async (): Promise<ApprovalDecision> => ({ kind: "always-allow", scope: "always" }),
    );
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: brokenStore,
    });
    const ctx = makeTurnContext({ requestApproval: approvalHandler });
    const result = await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    // Tool should still execute even though persistence failed
    expect(result?.output).toBe("done");
  });

  test("revokePersistentApproval removes grant", () => {
    const store = makeStore();
    store.grant("user-1", "agent:test", "bash", Date.now());

    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: store,
    });
    const revoked = mw.revokePersistentApproval("user-1", "agent:test", "bash");
    expect(revoked).toBe(true);
    expect(store.has("user-1", "agent:test", "bash")).toBe(false);
  });

  test("revokePersistentApproval returns false when no store configured", () => {
    const mw = createPermissionsMiddleware({ backend: askBackend() });
    expect(mw.revokePersistentApproval("user-1", "agent:test", "bash")).toBe(false);
  });

  test("revokeAllPersistentApprovals clears all grants", () => {
    const store = makeStore();
    store.grant("user-1", "agent:test", "bash", Date.now());
    store.grant("user-1", "agent:test", "write", Date.now());

    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: store,
    });
    mw.revokeAllPersistentApprovals();
    expect(store.list()).toHaveLength(0);
  });

  test("listPersistentApprovals returns grants", () => {
    const store = makeStore();
    store.grant("user-1", "agent:test", "bash", 1000);

    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: store,
    });
    const grants = mw.listPersistentApprovals();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.toolId).toBe("bash");
  });

  test("listPersistentApprovals returns empty array when no store configured", () => {
    const mw = createPermissionsMiddleware({ backend: askBackend() });
    expect(mw.listPersistentApprovals()).toEqual([]);
  });

  test("persistent grant emits audit with permissionEvent 'remembered'", async () => {
    const store = makeStore();
    store.grant("user-1", "agent:test", "bash", Date.now());

    const auditEntries: unknown[] = [];
    const mw = createPermissionsMiddleware({
      backend: askBackend(),
      persistentApprovals: store,
      auditSink: {
        log: async (entry) => {
          auditEntries.push(entry);
        },
      },
    });
    const ctx = makeTurnContext({
      requestApproval: async () => ({ kind: "allow" }),
    });
    await mw.wrapToolCall?.(ctx, makeToolRequest("bash"), noopToolHandler);

    const approvalEntry = auditEntries.find(
      (e) =>
        (e as Record<string, unknown>).metadata !== undefined &&
        (e as Record<string, Record<string, unknown>>).metadata?.permissionEvent === "remembered",
    );
    expect(approvalEntry).toBeDefined();
  });
});
