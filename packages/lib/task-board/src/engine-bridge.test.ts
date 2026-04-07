import { describe, expect, test } from "bun:test";
import type { AgentId, EngineEvent, TaskItemId, TaskStatus } from "@koi/core";
import { agentId, taskItemId } from "@koi/core";
import { createTaskBoard } from "./board.js";
import { createWiredTaskBoard, mapTaskBoardEventToEngineEvents } from "./engine-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT = agentId("agent-1");
const CLOCK = (): number => 1000;

function tid(id: string): TaskItemId {
  return taskItemId(id);
}

/** Creates a board with onEvent wired to the bridge. */
function createWiredBoard(
  agentId: AgentId = AGENT,
  clock: () => number = CLOCK,
): {
  readonly engineEvents: EngineEvent[];
  readonly board: ReturnType<typeof createTaskBoard>;
} {
  const engineEvents: EngineEvent[] = [];
  const board = createTaskBoard({
    onEvent: (event, newBoard) => {
      const mapped = mapTaskBoardEventToEngineEvents(event, newBoard, agentId, clock);
      engineEvents.push(...mapped);
    },
  });
  return { engineEvents, board };
}

// ---------------------------------------------------------------------------
// task:added
// ---------------------------------------------------------------------------

describe("task:added mapping", () => {
  test("emits task_progress only (non-structural to avoid O(N^2) batch traffic)", () => {
    const { engineEvents, board } = createWiredBoard();
    const result = board.add({ id: tid("t1"), description: "Do thing", subject: "Thing" });
    expect(result.ok).toBe(true);

    expect(engineEvents).toHaveLength(1);
    const progress = engineEvents[0] as EngineEvent & { readonly kind: "task_progress" };
    expect(progress.kind).toBe("task_progress");
    expect(progress.taskId).toBe(tid("t1"));
    expect(progress.subject).toBe("Thing");
    expect(progress.previousStatus).toBe("pending");
    expect(progress.status).toBe("pending");
    expect(progress.timestamp).toBe(1000);
  });

  test("added task does not carry activeForm (pending status, not in_progress)", () => {
    const { engineEvents, board } = createWiredBoard();
    board.add({
      id: tid("t1"),
      description: "Do thing",
      subject: "Thing",
      activeForm: "Doing thing",
    });

    const progress = engineEvents[0] as EngineEvent & { readonly kind: "task_progress" };
    // activeForm is suppressed for non-in_progress tasks to avoid stale spinner text
    expect(progress.activeForm).toBeUndefined();
  });

  test("addAll emits bounded events (no O(N^2) snapshots)", () => {
    const { engineEvents, board } = createWiredBoard();
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: tid(`t${i}`),
      description: `Task ${i}`,
    }));
    const result = board.addAll(tasks);
    expect(result.ok).toBe(true);
    // Should be 20 task_progress events, 0 plan_update snapshots
    const progressCount = engineEvents.filter((e) => e.kind === "task_progress").length;
    const snapshotCount = engineEvents.filter((e) => e.kind === "plan_update").length;
    expect(progressCount).toBe(20);
    expect(snapshotCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// task:assigned
// ---------------------------------------------------------------------------

describe("task:assigned mapping", () => {
  test("emits task_progress only (non-structural)", () => {
    const { engineEvents, board } = createWiredBoard();
    const r1 = board.add({ id: tid("t1"), description: "Do thing" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    engineEvents.length = 0; // clear add events

    const r2 = r1.value.assign(tid("t1"), AGENT);
    expect(r2.ok).toBe(true);

    expect(engineEvents).toHaveLength(1);
    const progress = engineEvents[0] as EngineEvent & { readonly kind: "task_progress" };
    expect(progress.kind).toBe("task_progress");
    expect(progress.previousStatus).toBe("pending");
    expect(progress.status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// task:completed
// ---------------------------------------------------------------------------

describe("task:completed mapping", () => {
  test("emits task_progress + plan_update", () => {
    const { engineEvents, board } = createWiredBoard();
    const r1 = board.add({ id: tid("t1"), description: "Do thing", subject: "Thing" });
    if (!r1.ok) return;
    const r2 = r1.value.assign(tid("t1"), AGENT);
    if (!r2.ok) return;
    engineEvents.length = 0;

    const r3 = r2.value.complete(tid("t1"), {
      taskId: tid("t1"),
      output: "done",
      durationMs: 100,
    });
    expect(r3.ok).toBe(true);

    expect(engineEvents).toHaveLength(2);
    const progress = engineEvents[0] as EngineEvent & { readonly kind: "task_progress" };
    expect(progress.previousStatus).toBe("in_progress");
    expect(progress.status).toBe("completed");

    const update = engineEvents[1] as EngineEvent & { readonly kind: "plan_update" };
    expect(update.tasks[0]?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// task:failed
// ---------------------------------------------------------------------------

describe("task:failed mapping", () => {
  test("emits task_progress + plan_update with error detail", () => {
    const { engineEvents, board } = createWiredBoard();
    const r1 = board.add({ id: tid("t1"), description: "Do thing", subject: "Thing" });
    if (!r1.ok) return;
    const r2 = r1.value.assign(tid("t1"), AGENT);
    if (!r2.ok) return;
    engineEvents.length = 0;

    const r3 = r2.value.fail(tid("t1"), {
      code: "INTERNAL",
      message: "Something broke",
      retryable: false,
    });
    expect(r3.ok).toBe(true);

    expect(engineEvents).toHaveLength(2);
    const progress = engineEvents[0] as EngineEvent & { readonly kind: "task_progress" };
    expect(progress.previousStatus).toBe("in_progress");
    expect(progress.status).toBe("failed");
    expect(progress.detail).toBe("Something broke");
  });
});

// ---------------------------------------------------------------------------
// task:killed
// ---------------------------------------------------------------------------

describe("task:killed mapping", () => {
  test("carries previousStatus from event (pending)", () => {
    const { engineEvents, board } = createWiredBoard();
    const r1 = board.add({ id: tid("t1"), description: "Do thing" });
    if (!r1.ok) return;
    engineEvents.length = 0;

    const r2 = r1.value.kill(tid("t1"));
    expect(r2.ok).toBe(true);

    expect(engineEvents).toHaveLength(2);
    const progress = engineEvents[0] as EngineEvent & { readonly kind: "task_progress" };
    expect(progress.previousStatus).toBe("pending");
    expect(progress.status).toBe("killed");
  });

  test("carries previousStatus from event (in_progress)", () => {
    const { engineEvents, board } = createWiredBoard();
    const r1 = board.add({ id: tid("t1"), description: "Do thing" });
    if (!r1.ok) return;
    const r2 = r1.value.assign(tid("t1"), AGENT);
    if (!r2.ok) return;
    engineEvents.length = 0;

    const r3 = r2.value.kill(tid("t1"));
    expect(r3.ok).toBe(true);

    const progress = engineEvents[0] as EngineEvent & { readonly kind: "task_progress" };
    expect(progress.previousStatus).toBe("in_progress");
    expect(progress.status).toBe("killed");
  });
});

// ---------------------------------------------------------------------------
// task:unreachable
// ---------------------------------------------------------------------------

describe("task:unreachable mapping", () => {
  test("emits task_progress only (non-structural to avoid cascade O(N))", () => {
    const { engineEvents, board } = createWiredBoard();
    const r1 = board.add({ id: tid("t1"), description: "Parent" });
    if (!r1.ok) return;
    const r2 = r1.value.add({
      id: tid("t2"),
      description: "Child",
      subject: "Child task",
      dependencies: [tid("t1")],
    });
    if (!r2.ok) return;
    const r3 = r2.value.assign(tid("t1"), AGENT);
    if (!r3.ok) return;
    engineEvents.length = 0;

    // Fail t1 → t2 becomes unreachable
    const r4 = r3.value.fail(tid("t1"), {
      code: "INTERNAL",
      message: "failed",
      retryable: false,
    });
    expect(r4.ok).toBe(true);

    // t2 gets a task_progress (from task:unreachable)
    const unreachableProgress = engineEvents.find(
      (e) =>
        e.kind === "task_progress" && (e as { readonly taskId: TaskItemId }).taskId === tid("t2"),
    ) as (EngineEvent & { readonly kind: "task_progress" }) | undefined;
    expect(unreachableProgress).toBeDefined();
    expect(unreachableProgress?.previousStatus).toBe("pending");
    expect(unreachableProgress?.status).toBe("pending");

    // plan_update from task:failed (structural) includes blockedBy for t2
    const planUpdate = engineEvents.find((e) => e.kind === "plan_update") as
      | (EngineEvent & { readonly kind: "plan_update" })
      | undefined;
    expect(planUpdate).toBeDefined();
    const t2InPlan = planUpdate?.tasks.find((t) => t.id === tid("t2"));
    expect(t2InPlan?.blockedBy).toBe(tid("t1"));
  });
});

// ---------------------------------------------------------------------------
// task:updated
// ---------------------------------------------------------------------------

describe("task:updated mapping", () => {
  test("emits task_progress with same status + plan_update", () => {
    const { engineEvents, board } = createWiredBoard();
    const r1 = board.add({ id: tid("t1"), description: "Do thing", subject: "Original" });
    if (!r1.ok) return;
    const r2 = r1.value.assign(tid("t1"), AGENT);
    if (!r2.ok) return;
    engineEvents.length = 0;

    const r3 = r2.value.update(tid("t1"), { subject: "Updated", activeForm: "Working on it" });
    expect(r3.ok).toBe(true);

    expect(engineEvents).toHaveLength(2);
    const progress = engineEvents[0] as EngineEvent & { readonly kind: "task_progress" };
    expect(progress.previousStatus).toBe("in_progress");
    expect(progress.status).toBe("in_progress");
    expect(progress.subject).toBe("Updated");
    expect(progress.activeForm).toBe("Working on it");

    const update = engineEvents[1] as EngineEvent & { readonly kind: "plan_update" };
    const t1 = update.tasks.find((t) => t.id === tid("t1"));
    expect(t1?.subject).toBe("Updated");
    expect(t1?.activeForm).toBe("Working on it");
  });
});

// ---------------------------------------------------------------------------
// task:retried
// ---------------------------------------------------------------------------

describe("task:retried mapping", () => {
  test("emits task_progress only (non-structural)", () => {
    const { engineEvents, board } = createWiredBoard();
    const r1 = board.add({ id: tid("t1"), description: "Do thing" });
    if (!r1.ok) return;
    const r2 = r1.value.assign(tid("t1"), AGENT);
    if (!r2.ok) return;
    engineEvents.length = 0;

    // Retryable failure
    const r3 = r2.value.fail(tid("t1"), {
      code: "TIMEOUT",
      message: "timed out",
      retryable: true,
    });
    expect(r3.ok).toBe(true);

    // Should have task:retried → task_progress only (no plan_update for retry)
    const retryProgress = engineEvents.find(
      (e) =>
        e.kind === "task_progress" && (e as { readonly status: TaskStatus }).status === "pending",
    ) as (EngineEvent & { readonly kind: "task_progress" }) | undefined;
    expect(retryProgress).toBeDefined();
    expect(retryProgress?.previousStatus).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// task:unassigned
// ---------------------------------------------------------------------------

describe("task:unassigned mapping", () => {
  test("emits task_progress only", () => {
    const { engineEvents, board } = createWiredBoard();
    const r1 = board.add({ id: tid("t1"), description: "Do thing" });
    if (!r1.ok) return;
    const r2 = r1.value.assign(tid("t1"), AGENT);
    if (!r2.ok) return;
    engineEvents.length = 0;

    const r3 = r2.value.unassign(tid("t1"));
    expect(r3.ok).toBe(true);

    expect(engineEvents).toHaveLength(1);
    const progress = engineEvents[0] as EngineEvent & { readonly kind: "task_progress" };
    expect(progress.previousStatus).toBe("in_progress");
    expect(progress.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// createWiredTaskBoard convenience factory
// ---------------------------------------------------------------------------

describe("createWiredTaskBoard", () => {
  test("emits EngineEvents on mutations without manual wiring", () => {
    const engineEvents: EngineEvent[] = [];
    const board = createWiredTaskBoard({
      agentId: AGENT,
      onEngineEvent: (e) => engineEvents.push(e),
      clock: CLOCK,
    });

    const r1 = board.add({ id: tid("t1"), description: "Do thing", subject: "Thing" });
    expect(r1.ok).toBe(true);
    expect(engineEvents).toHaveLength(1);
    expect(engineEvents[0]?.kind).toBe("task_progress");
  });

  test("passes through config options", () => {
    const engineEvents: EngineEvent[] = [];
    const board = createWiredTaskBoard({
      agentId: AGENT,
      onEngineEvent: (e) => engineEvents.push(e),
      config: { maxRetries: 0 },
    });

    const r1 = board.add({ id: tid("t1"), description: "Do thing" });
    if (!r1.ok) return;
    const r2 = r1.value.assign(tid("t1"), AGENT);
    if (!r2.ok) return;
    // With maxRetries: 0, retryable errors should fail terminally
    const r3 = r2.value.fail(tid("t1"), {
      code: "TIMEOUT",
      message: "timed out",
      retryable: true,
    });
    expect(r3.ok).toBe(true);
    // Should get task:failed (not task:retried) since maxRetries=0
    const failProgress = engineEvents.find(
      (e) =>
        e.kind === "task_progress" && (e as { readonly status: TaskStatus }).status === "failed",
    );
    expect(failProgress).toBeDefined();
  });
});
