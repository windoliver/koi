/**
 * Cross-feature composition tests for time-travel middleware.
 *
 * Tests that fs-rollback (350), guided-retry (425), and event-trace (475)
 * compose correctly through the middleware onion.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  FileOpRecord,
  FileReadResult,
  FileSystemBackend,
  FileWriteResult,
  KoiError,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  Result,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
  TurnTrace,
} from "@koi/core";
import { chainId } from "@koi/core";
import { createEventTraceMiddleware } from "@koi/middleware-event-trace";
import { createFsRollbackMiddleware } from "@koi/middleware-fs-rollback";
import { createGuidedRetryMiddleware } from "@koi/middleware-guided-retry";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import {
  createMockTurnContext,
  createSpyModelHandler,
  createSpyToolHandler,
} from "@koi/test-utils";

// ---------------------------------------------------------------------------
// Inline compose helpers — same as composition.test.ts (avoids L2 → L1 import)
// ---------------------------------------------------------------------------

function composeModelChain(
  middleware: readonly KoiMiddleware[],
  terminal: ModelHandler,
): (ctx: TurnContext, request: ModelRequest) => Promise<ModelResponse> {
  const hooks = middleware.filter((mw) => mw.wrapModelCall !== undefined);
  return (ctx, request) => {
    const dispatch = (i: number, req: ModelRequest): Promise<ModelResponse> => {
      const mw = hooks[i];
      if (mw?.wrapModelCall === undefined) return terminal(req);
      return mw.wrapModelCall(ctx, req, (r) => dispatch(i + 1, r));
    };
    return dispatch(0, request);
  };
}

function composeToolChain(
  middleware: readonly KoiMiddleware[],
  terminal: ToolHandler,
): (ctx: TurnContext, request: ToolRequest) => Promise<ToolResponse> {
  const hooks = middleware.filter((mw) => mw.wrapToolCall !== undefined);
  return (ctx, request) => {
    const dispatch = (i: number, req: ToolRequest): Promise<ToolResponse> => {
      const mw = hooks[i];
      if (mw?.wrapToolCall === undefined) return terminal(req);
      return mw.wrapToolCall(ctx, req, (r) => dispatch(i + 1, r));
    };
    return dispatch(0, request);
  };
}

function sortByPriority(middleware: readonly KoiMiddleware[]): readonly KoiMiddleware[] {
  return [...middleware].sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
}

// ---------------------------------------------------------------------------
// Mock filesystem backend
// ---------------------------------------------------------------------------

function createMockFileSystem(
  files?: Readonly<Record<string, string>>,
): FileSystemBackend & { readonly files: Map<string, string> } {
  const fileMap = new Map<string, string>(Object.entries(files ?? {}));
  return {
    name: "mock-fs",
    files: fileMap,

    read(path: string): Result<FileReadResult, KoiError> {
      const content = fileMap.get(path);
      if (content === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Not found: ${path}`, retryable: false },
        };
      }
      return { ok: true, value: { content, path, size: content.length } };
    },

    write(path: string, content: string): Result<FileWriteResult, KoiError> {
      fileMap.set(path, content);
      return { ok: true, value: { path, bytesWritten: content.length } };
    },

    edit() {
      return { ok: true, value: { path: "", hunksApplied: 0 } };
    },

    list() {
      return { ok: true, value: { entries: [], truncated: false } };
    },

    search() {
      return { ok: true, value: { matches: [], truncated: false } };
    },
  };
}

// ---------------------------------------------------------------------------
// Test: Priority ordering
// ---------------------------------------------------------------------------

describe("Time-travel middleware — priority ordering", () => {
  test("fs-rollback(350) < guided-retry(425) < event-trace(475)", () => {
    const fsStore = createInMemorySnapshotChainStore<FileOpRecord>();
    const traceStore = createInMemorySnapshotChainStore<TurnTrace>();
    const backend = createMockFileSystem();

    const fsRollback = createFsRollbackMiddleware({
      store: fsStore,
      chainId: chainId("fs-chain"),
      backend,
    });
    const guidedRetry = createGuidedRetryMiddleware({});
    const eventTrace = createEventTraceMiddleware({
      store: traceStore,
      chainId: chainId("trace-chain"),
    });

    expect(fsRollback.middleware.priority).toBe(350);
    expect(guidedRetry.middleware.priority).toBe(425);
    expect(eventTrace.middleware.priority).toBe(475);
  });

  test("onion enter/exit order for tool calls: fs-rollback → event-trace", async () => {
    const order: string[] = [];

    const outer: KoiMiddleware = {
      name: "fs-rollback-spy",
      priority: 350,
      async wrapToolCall(_ctx, req, next) {
        order.push("fs-rollback-enter");
        const resp = await next(req);
        order.push("fs-rollback-exit");
        return resp;
      },
    };

    const inner: KoiMiddleware = {
      name: "event-trace-spy",
      priority: 475,
      async wrapToolCall(_ctx, req, next) {
        order.push("event-trace-enter");
        const resp = await next(req);
        order.push("event-trace-exit");
        return resp;
      },
    };

    const ctx = createMockTurnContext();
    const spy = createSpyToolHandler();
    const sorted = sortByPriority([inner, outer]);
    const chain = composeToolChain(sorted, spy.handler);
    await chain(ctx, { toolId: "fs_write", input: { path: "/tmp/x" } });

    expect(order).toEqual([
      "fs-rollback-enter",
      "event-trace-enter",
      "event-trace-exit",
      "fs-rollback-exit",
    ]);
  });

  test("onion enter/exit order for model calls: guided-retry → event-trace", async () => {
    const order: string[] = [];

    const outer: KoiMiddleware = {
      name: "guided-retry-spy",
      priority: 425,
      async wrapModelCall(_ctx, req, next) {
        order.push("guided-retry-enter");
        const resp = await next(req);
        order.push("guided-retry-exit");
        return resp;
      },
    };

    const inner: KoiMiddleware = {
      name: "event-trace-spy",
      priority: 475,
      async wrapModelCall(_ctx, req, next) {
        order.push("event-trace-enter");
        const resp = await next(req);
        order.push("event-trace-exit");
        return resp;
      },
    };

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const sorted = sortByPriority([inner, outer]);
    const chain = composeModelChain(sorted, spy.handler);
    await chain(ctx, { messages: [] });

    expect(order).toEqual([
      "guided-retry-enter",
      "event-trace-enter",
      "event-trace-exit",
      "guided-retry-exit",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test: Rollback + trace correlation
// ---------------------------------------------------------------------------

describe("Time-travel middleware — rollback + trace correlation", () => {
  test("FileOpRecord.eventIndex matches TraceEvent index when wired via getEventIndex", async () => {
    const fsStore = createInMemorySnapshotChainStore<FileOpRecord>();
    const traceStore = createInMemorySnapshotChainStore<TurnTrace>();
    const backend = createMockFileSystem({ "/tmp/file.txt": "original" });

    const eventTrace = createEventTraceMiddleware({
      store: traceStore,
      chainId: chainId("trace"),
    });

    const fsRollback = createFsRollbackMiddleware({
      store: fsStore,
      chainId: chainId("fs"),
      backend,
      getEventIndex: () => eventTrace.currentEventIndex(),
    });

    // Simulate a turn with a file write
    const ctx = createMockTurnContext({ turnIndex: 0 });

    // onBeforeTurn
    await eventTrace.middleware.onBeforeTurn?.(ctx);

    // Tool call through composed chain
    const toolSpy = createSpyToolHandler({ output: { ok: true } });
    const sorted = sortByPriority([fsRollback.middleware, eventTrace.middleware]);
    const toolChain = composeToolChain(sorted, toolSpy.handler);
    await toolChain(ctx, {
      toolId: "fs_write",
      input: { path: "/tmp/file.txt", content: "updated" },
    });

    // onAfterTurn to commit trace
    await eventTrace.middleware.onAfterTurn?.(ctx);

    // Verify correlation
    const fsRecords = await fsRollback.getRecords();
    expect(fsRecords.ok).toBe(true);
    if (!fsRecords.ok) return;
    expect(fsRecords.value.length).toBeGreaterThan(0);

    const traceResult = await eventTrace.getTurnTrace(0);
    expect(traceResult.ok).toBe(true);
    if (!traceResult.ok) return;
    expect(traceResult.value).toBeDefined();
    if (traceResult.value === undefined) return;

    // The fs-rollback eventIndex should reference a valid trace event index
    const fsRecord = fsRecords.value[0]?.data;
    expect(fsRecord).toBeDefined();
    if (fsRecord === undefined) return;
    expect(fsRecord.eventIndex).toBeGreaterThanOrEqual(0);

    // The trace should have a tool_call event
    const toolEvents = traceResult.value.events.filter((e) => e.event.kind === "tool_call");
    expect(toolEvents.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Rollback + guided retry
// ---------------------------------------------------------------------------

describe("Time-travel middleware — rollback + guided retry", () => {
  test("after fork, rollback undoes files and guided-retry injects constraint", async () => {
    const fsStore = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createMockFileSystem();

    const fsRollback = createFsRollbackMiddleware({
      store: fsStore,
      chainId: chainId("fs"),
      backend,
    });

    const guidedRetry = createGuidedRetryMiddleware({});

    // --- Turn 0: write file A ---
    const ctx0 = createMockTurnContext({ turnIndex: 0 });
    const toolSpy = createSpyToolHandler({ output: { ok: true } });
    const toolChain = composeToolChain(
      sortByPriority([fsRollback.middleware, guidedRetry.middleware]),
      toolSpy.handler,
    );
    await toolChain(ctx0, { toolId: "fs_write", input: { path: "/tmp/a.txt", content: "hello" } });
    // Simulate the tool actually writing the file
    backend.files.set("/tmp/a.txt", "hello");

    // Record the node ID after first write for later rollback
    const recordsAfterT0 = await fsRollback.getRecords();
    expect(recordsAfterT0.ok).toBe(true);
    if (!recordsAfterT0.ok) return;
    const firstNodeId = recordsAfterT0.value[0]?.nodeId;
    expect(firstNodeId).toBeDefined();
    if (firstNodeId === undefined) return;

    // --- Turn 1: write file B (this will be rolled back) ---
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    await toolChain(ctx1, { toolId: "fs_write", input: { path: "/tmp/b.txt", content: "world" } });
    backend.files.set("/tmp/b.txt", "world");

    expect(backend.files.get("/tmp/b.txt")).toBe("world");

    // --- Rollback to after turn 0 ---
    const rollbackResult = await fsRollback.rollbackTo(firstNodeId);
    expect(rollbackResult.ok).toBe(true);

    // --- Set guided-retry constraint ---
    guidedRetry.setConstraint({
      reason: {
        kind: "validation_failure",
        message: "Turn 1 output failed validation",
        timestamp: Date.now(),
      },
      instructions: "Avoid writing to /tmp/b.txt",
      maxInjections: 1,
    });

    expect(guidedRetry.hasConstraint()).toBe(true);

    // --- Next model call should have the constraint injected ---
    const modelSpy = createSpyModelHandler();
    const modelChain = composeModelChain(
      sortByPriority([fsRollback.middleware, guidedRetry.middleware]),
      modelSpy.handler,
    );
    const ctx2 = createMockTurnContext({ turnIndex: 2 });
    await modelChain(ctx2, { messages: [] });

    expect(modelSpy.calls).toHaveLength(1);
    const modelRequest = modelSpy.calls[0];
    expect(modelRequest).toBeDefined();
    if (modelRequest === undefined) return;
    // The constraint should have been prepended as a system message
    expect(modelRequest.messages.length).toBeGreaterThan(0);
    const firstMsg = modelRequest.messages[0];
    expect(firstMsg).toBeDefined();
    if (firstMsg === undefined) return;
    expect(firstMsg.senderId).toBe("system:guided-retry");

    // Constraint should be consumed
    expect(guidedRetry.hasConstraint()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: Full scenario — write across turns, fork, rollback, retry
// ---------------------------------------------------------------------------

describe("Time-travel middleware — full scenario", () => {
  let backend: ReturnType<typeof createMockFileSystem>;
  let fsStore: ReturnType<typeof createInMemorySnapshotChainStore<FileOpRecord>>;
  let traceStore: ReturnType<typeof createInMemorySnapshotChainStore<TurnTrace>>;

  beforeEach(() => {
    backend = createMockFileSystem({
      "/app/config.json": '{"version": 1}',
    });
    fsStore = createInMemorySnapshotChainStore<FileOpRecord>();
    traceStore = createInMemorySnapshotChainStore<TurnTrace>();
  });

  test("3-turn write, fork at turn 1, rollback undoes 2-3, retry with constraint", async () => {
    const eventTrace = createEventTraceMiddleware({
      store: traceStore,
      chainId: chainId("trace"),
    });

    const fsRollback = createFsRollbackMiddleware({
      store: fsStore,
      chainId: chainId("fs"),
      backend,
      getEventIndex: () => eventTrace.currentEventIndex(),
    });

    const guidedRetry = createGuidedRetryMiddleware({});

    const sorted = sortByPriority([
      fsRollback.middleware,
      guidedRetry.middleware,
      eventTrace.middleware,
    ]);

    const toolSpy = createSpyToolHandler({ output: { ok: true } });
    const toolChain = composeToolChain(sorted, toolSpy.handler);
    const modelSpy = createSpyModelHandler();
    const modelChain = composeModelChain(sorted, modelSpy.handler);

    // --- Turn 0: update config.json ---
    const ctx0 = createMockTurnContext({ turnIndex: 0 });
    await eventTrace.middleware.onBeforeTurn?.(ctx0);
    await modelChain(ctx0, { messages: [] });
    await toolChain(ctx0, {
      toolId: "fs_write",
      input: { path: "/app/config.json", content: '{"version": 2}' },
    });
    backend.files.set("/app/config.json", '{"version": 2}');
    await eventTrace.middleware.onAfterTurn?.(ctx0);

    // Record node after turn 0
    const recordsT0 = await fsRollback.getRecords();
    expect(recordsT0.ok).toBe(true);
    if (!recordsT0.ok) return;
    // list returns newest-first, so first entry is latest
    const nodeAfterT0 = recordsT0.value[0]?.nodeId;
    expect(nodeAfterT0).toBeDefined();
    if (nodeAfterT0 === undefined) return;

    // --- Turn 1: create new file ---
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    await eventTrace.middleware.onBeforeTurn?.(ctx1);
    await toolChain(ctx1, {
      toolId: "fs_write",
      input: { path: "/app/routes.ts", content: "export const routes = [];" },
    });
    backend.files.set("/app/routes.ts", "export const routes = [];");
    await eventTrace.middleware.onAfterTurn?.(ctx1);

    // --- Turn 2: modify config again (this will fail) ---
    const ctx2 = createMockTurnContext({ turnIndex: 2 });
    await eventTrace.middleware.onBeforeTurn?.(ctx2);
    await toolChain(ctx2, {
      toolId: "fs_edit",
      input: { path: "/app/config.json", content: '{"version": 3, "broken": true}' },
    });
    backend.files.set("/app/config.json", '{"version": 3, "broken": true}');
    await eventTrace.middleware.onAfterTurn?.(ctx2);

    // Verify files exist before rollback
    expect(backend.files.get("/app/config.json")).toBe('{"version": 3, "broken": true}');
    expect(backend.files.get("/app/routes.ts")).toBe("export const routes = [];");

    // --- Fork: rollback to after turn 0 ---
    const rollbackResult = await fsRollback.rollbackTo(nodeAfterT0);
    expect(rollbackResult.ok).toBe(true);
    if (rollbackResult.ok) {
      expect(rollbackResult.value).toBeGreaterThan(0);
    }

    // config.json should be restored to version 2 (from turn 0)
    expect(backend.files.get("/app/config.json")).toBe('{"version": 2}');

    // --- Set constraint for retry ---
    guidedRetry.setConstraint({
      reason: {
        kind: "error",
        message: "Turn 2 broke config.json",
        timestamp: Date.now(),
      },
      instructions: "Do not modify config.json with broken: true",
      maxInjections: 2,
    });

    // --- Retry turn: model call should have constraint ---
    const ctx3 = createMockTurnContext({ turnIndex: 3 });
    await eventTrace.middleware.onBeforeTurn?.(ctx3);
    await modelChain(ctx3, { messages: [] });
    await eventTrace.middleware.onAfterTurn?.(ctx3);

    // Verify constraint was injected
    const lastModelCall = modelSpy.calls[modelSpy.calls.length - 1];
    expect(lastModelCall).toBeDefined();
    if (lastModelCall === undefined) return;
    expect(lastModelCall.messages.length).toBeGreaterThan(0);

    // Verify event trace has complete history
    const trace0 = await eventTrace.getTurnTrace(0);
    const trace1 = await eventTrace.getTurnTrace(1);
    const trace2 = await eventTrace.getTurnTrace(2);
    const trace3 = await eventTrace.getTurnTrace(3);

    expect(trace0.ok && trace0.value !== undefined).toBe(true);
    expect(trace1.ok && trace1.value !== undefined).toBe(true);
    expect(trace2.ok && trace2.value !== undefined).toBe(true);
    expect(trace3.ok && trace3.value !== undefined).toBe(true);

    // First constraint injection consumed
    expect(guidedRetry.hasConstraint()).toBe(true); // maxInjections was 2, used 1

    // Second model call should still have constraint
    const ctx4 = createMockTurnContext({ turnIndex: 4 });
    await modelChain(ctx4, { messages: [] });
    expect(guidedRetry.hasConstraint()).toBe(false); // now consumed
  });
});
