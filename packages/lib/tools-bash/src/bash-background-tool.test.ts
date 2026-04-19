/**
 * Tests for bash_background — watch_patterns extension.
 *
 * Covers:
 * - invalid watch_patterns → pre-spawn validation rejection (no task-board side effects)
 * - valid watch_patterns → matcher wires up, store sees records on match
 * - zero-pattern path → byte-identical behavior vs. baseline (regression)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentId, ManagedTaskBoard, TaskBoard, TaskItemId } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createPendingMatchStore } from "@koi/watch-patterns";
import type { BashBackgroundToolConfig } from "./bash-background-tool.js";
import { createBashBackgroundTool } from "./bash-background-tool.js";
import { createBashOutputBuffer } from "./output-buffer.js";

// ---------------------------------------------------------------------------
// Minimal in-memory task board stub
// ---------------------------------------------------------------------------

/** Monotonic counter for unique task IDs across board instances. */
let taskCounter = 0;

function makeTaskBoard(): ManagedTaskBoard {
  const ok = { ok: true as const, value: {} as unknown as TaskBoard };
  return {
    snapshot: () => ({ tasks: [], version: 0 }) as unknown as TaskBoard,
    nextId: async (): Promise<TaskItemId> => taskItemId(String(++taskCounter)),
    add: async () => ok,
    addAll: async () => ok,
    assign: async () => ok,
    unassign: async () => ok,
    startTask: async () => ok,
    hasResultPersistence: () => false,
    complete: async () => ok,
    completeOwnedTask: async () => ok,
    fail: async () => ok,
    failOwnedTask: async () => ok,
    kill: async () => ok,
    killIfPending: async () => ok,
    killOwnedTask: async () => ok,
    update: async () => ok,
    updateOwned: async () => ok,
    [Symbol.asyncDispose]: async () => {},
  };
}

/** Build a minimal config suitable for unit tests. Override fields as needed. */
function minimalConfig(
  overrides: Partial<BashBackgroundToolConfig> = {},
): BashBackgroundToolConfig {
  return {
    taskBoard: makeTaskBoard(),
    agentId: "test-agent" as AgentId,
    workspaceRoot: "/tmp",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBlocked(
  result: unknown,
): result is { error: string; category: string; reason: string; pattern: string } {
  return typeof result === "object" && result !== null && "error" in result && "category" in result;
}

function isStarted(
  result: unknown,
): result is { taskId: string; status: "in_progress"; message: string } {
  return typeof result === "object" && result !== null && "taskId" in result && "status" in result;
}

// ---------------------------------------------------------------------------
// watch_patterns — validation tests (no spawn needed)
// ---------------------------------------------------------------------------

describe("bash_background — watch_patterns validation (pre-spawn)", () => {
  beforeEach(() => {
    taskCounter = 0;
  });

  test("invalid regex (lookahead not supported by RE2) returns validation error pre-spawn", async () => {
    const board = makeTaskBoard();
    const addSpy = mock(board.add);
    const boardWithSpy = { ...board, add: addSpy };

    const tool = createBashBackgroundTool(minimalConfig({ taskBoard: boardWithSpy }));
    const result = await tool.execute(
      { command: "echo hi", watch_patterns: [{ pattern: "(?=lookahead)x", event: "ok" }] },
      {},
    );

    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.category).toBe("validation");
      expect(result.error).toBe("Invalid watch_patterns");
    }
    // Task board must NOT have been called — reject before task creation
    expect(addSpy).not.toHaveBeenCalled();
  });

  test("invalid event name (uppercase) returns validation error pre-spawn", async () => {
    const board = makeTaskBoard();
    const addSpy = mock(board.add);
    const boardWithSpy = { ...board, add: addSpy };

    const tool = createBashBackgroundTool(minimalConfig({ taskBoard: boardWithSpy }));
    const result = await tool.execute(
      { command: "echo hi", watch_patterns: [{ pattern: "ready", event: "UPPER_CASE" }] },
      {},
    );

    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.category).toBe("validation");
    }
    expect(addSpy).not.toHaveBeenCalled();
  });

  test("reserved __-prefixed event returns validation error pre-spawn", async () => {
    const tool = createBashBackgroundTool(minimalConfig());
    const result = await tool.execute(
      { command: "echo hi", watch_patterns: [{ pattern: "ready", event: "__reserved" }] },
      {},
    );

    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.category).toBe("validation");
    }
  });

  test("disallowed 'g' flag returns validation error pre-spawn", async () => {
    const tool = createBashBackgroundTool(minimalConfig());
    const result = await tool.execute(
      { command: "echo hi", watch_patterns: [{ pattern: "ready", event: "ok", flags: "g" }] },
      {},
    );

    expect(isBlocked(result)).toBe(true);
    if (isBlocked(result)) {
      expect(result.category).toBe("validation");
    }
  });
});

// ---------------------------------------------------------------------------
// watch_patterns — functional tests (real subprocess)
// ---------------------------------------------------------------------------

describe("bash_background — watch_patterns functional", () => {
  beforeEach(() => {
    taskCounter = 0;
  });

  test("valid watch_patterns: store receives match record on stdout match", async () => {
    const store = createPendingMatchStore();

    const tool = createBashBackgroundTool(minimalConfig({ getWatchStore: () => store }));

    const result = await tool.execute(
      {
        command: "echo server-ready",
        watch_patterns: [{ pattern: "ready", event: "ready" }],
      },
      {},
    );

    expect(isStarted(result)).toBe(true);

    // Poll until the subprocess completes and the matcher fires.
    // Timeout: 40 × 50ms = 2 seconds.
    for (let i = 0; i < 40 && store.pending() === 0; i++) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }

    expect(store.pending()).toBeGreaterThan(0);
    const snap = store.peek({});
    expect(snap.some((c) => c.event === "ready")).toBe(true);
  });

  test("zero-pattern path: store is untouched when no watch_patterns supplied", async () => {
    const store = createPendingMatchStore();

    const tool = createBashBackgroundTool(minimalConfig({ getWatchStore: () => store }));

    const result = await tool.execute({ command: "echo hello" }, {});

    expect(isStarted(result)).toBe(true);

    // Wait enough time for the subprocess to complete.
    await new Promise<void>((r) => setTimeout(r, 400));

    // Store must remain empty — no patterns, no records.
    expect(store.pending()).toBe(0);
  });

  test("getWatchStore undefined: valid patterns do not crash (no-op path)", async () => {
    // getWatchStore not provided — matcher is skipped even with valid patterns.
    const tool = createBashBackgroundTool(minimalConfig());

    const result = await tool.execute(
      {
        command: "echo ready",
        watch_patterns: [{ pattern: "ready", event: "ready" }],
      },
      {},
    );

    // Should still start the task (no crash).
    expect(isStarted(result)).toBe(true);
  });

  test("empty watch_patterns array is treated as zero-pattern path", async () => {
    const store = createPendingMatchStore();
    const tool = createBashBackgroundTool(minimalConfig({ getWatchStore: () => store }));

    const result = await tool.execute({ command: "echo hello", watch_patterns: [] }, {});

    expect(isStarted(result)).toBe(true);
    await new Promise<void>((r) => setTimeout(r, 400));
    expect(store.pending()).toBe(0);
  });

  test("markOutputBufferTerminal is called when task enters terminal state (buffer is kept)", async () => {
    const markedTerminal: TaskItemId[] = [];
    const buffers = new Map<TaskItemId, ReturnType<typeof createBashOutputBuffer>>();

    const tool = createBashBackgroundTool(
      minimalConfig({
        getOutputBuffer: (id) => {
          let buf = buffers.get(id);
          if (buf === undefined) {
            buf = createBashOutputBuffer({ maxBytes: 1_000_000 });
            buffers.set(id, buf);
          }
          return buf;
        },
        markOutputBufferTerminal: (id) => {
          markedTerminal.push(id);
          // Intentionally do NOT delete from buffers — postmortem reads must still work.
        },
      }),
    );

    const result = await tool.execute({ command: "echo hi" }, {});
    expect(isStarted(result)).toBe(true);
    if (!isStarted(result)) throw new Error("expected started");
    const taskId = result.taskId as TaskItemId;

    // Poll until the subprocess exits and markOutputBufferTerminal fires.
    // Timeout: 40 × 50ms = 2 seconds.
    for (let i = 0; i < 40 && markedTerminal.length === 0; i++) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }

    // markOutputBufferTerminal must have fired with the correct task id.
    expect(markedTerminal).toContain(taskId);
    // Buffer must still exist for postmortem reads — not deleted by the tool.
    expect(buffers.has(taskId)).toBe(true);
  });

  test("matched lines are written to outputBuffer's side-buffer for task_output(matches_only)", async () => {
    const store = createPendingMatchStore();
    const buffer = createBashOutputBuffer({ maxBytes: 1_000_000 });

    const tool = createBashBackgroundTool(
      minimalConfig({
        getWatchStore: () => store,
        getOutputBuffer: () => buffer,
      }),
    );

    const result = await tool.execute(
      {
        command: "echo 'server ready now'",
        watch_patterns: [{ pattern: "ready", event: "ready" }],
      },
      {},
    );

    expect(isStarted(result)).toBe(true);

    // Poll until the match lands in the buffer side-buffer.
    for (let i = 0; i < 40 && buffer.queryMatches({}).entries.length === 0; i++) {
      await new Promise<void>((r) => setTimeout(r, 50));
    }

    const res = buffer.queryMatches({});
    expect(res.entries.length).toBeGreaterThan(0);
    const entry = res.entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("entry must be defined");
    expect(entry.event).toBe("ready");
    expect(entry.line).toContain("ready");
    expect(entry.matchSpanUnits.start).toBeGreaterThanOrEqual(0);
    expect(entry.matchSpanUnits.end).toBeGreaterThan(entry.matchSpanUnits.start);
    // The matched span should correspond to "ready" in the line.
    expect(entry.line.slice(entry.matchSpanUnits.start, entry.matchSpanUnits.end)).toBe("ready");
  });
});
