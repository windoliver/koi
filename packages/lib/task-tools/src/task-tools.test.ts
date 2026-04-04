/**
 * @koi/task-tools — unit tests for all 6 task management tools.
 *
 * Uses an in-memory store — no filesystem, no external deps.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, Tool } from "@koi/core";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { z } from "zod";
import { createTaskTools } from "./create-task-tools.js";

async function freshResultsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "koi-task-tools-test-"));
}

function agentId(id: string): import("@koi/core").AgentId {
  return id as import("@koi/core").AgentId;
}

/** Tools are always 7 elements — assert here once rather than using ! at every callsite. */
interface ToolSet {
  readonly tools: readonly Tool[];
  readonly create: Tool;
  readonly get: Tool;
  readonly update: Tool;
  readonly list: Tool;
  readonly stop: Tool;
  readonly output: Tool;
  readonly delegate: Tool;
}

async function setup(): Promise<ToolSet> {
  const store = createMemoryTaskBoardStore();
  // Use a real resultsDir — task_update(status: completed) now requires durable storage
  const resultsDir = await freshResultsDir();
  const board = await createManagedTaskBoard({ store, resultsDir });
  const tools = createTaskTools({ board, agentId: agentId("agent-1") });
  if (tools.length < 7) throw new Error("Expected 7 task tools");
  const [create, get, update, list, stop, output, delegate] = tools as [
    Tool,
    Tool,
    Tool,
    Tool,
    Tool,
    Tool,
    Tool,
  ];
  return { tools, create, get, update, list, stop, output, delegate };
}

async function exec(tool: Tool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await tool.execute(args as JsonObject)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// task_create
// ---------------------------------------------------------------------------

describe("task_create", () => {
  test("creates task with subject + description, returns task with generated ID", async () => {
    const { create } = await setup();
    const r = await exec(create, { subject: "Auth module", description: "Implement OAuth2 flow" });
    expect(r.ok).toBe(true);
    const task = r.task as Record<string, unknown>;
    expect(typeof task.id).toBe("string");
    expect(task.subject).toBe("Auth module");
    expect(task.status).toBe("pending");
  });

  test("creates task with dependencies — blockedBy populated when dep is pending", async () => {
    const { create } = await setup();
    const r1 = await exec(create, { subject: "Task A", description: "First task" });
    expect(r1.ok).toBe(true);
    const idA = (r1.task as Record<string, unknown>).id as string;

    const r2 = await exec(create, {
      subject: "Task B",
      description: "Depends on A",
      dependencies: [idA],
    });
    expect(r2.ok).toBe(true);
    const taskB = r2.task as Record<string, unknown>;
    expect(taskB.dependencies).toEqual([idA]);
    expect(taskB.blockedBy).toBe(idA);
  });

  test("creates task with active_form — activeForm set on task", async () => {
    const { create } = await setup();
    const r = await exec(create, {
      subject: "Auth module",
      description: "Implement OAuth2 flow",
      active_form: "Planning auth module",
    });
    expect(r.ok).toBe(true);
    expect((r.task as Record<string, unknown>).activeForm).toBe("Planning auth module");
  });

  // Zod boundary tests
  test("rejects missing description", async () => {
    const { create } = await setup();
    const r = await exec(create, { subject: "Task A" });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  test("rejects non-string description", async () => {
    const { create } = await setup();
    const r = await exec(create, { subject: "Task A", description: 42 });
    expect(r.ok).toBe(false);
  });

  test("rejects empty string description", async () => {
    const { create } = await setup();
    const r = await exec(create, { subject: "Task A", description: "" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// task_get
// ---------------------------------------------------------------------------

describe("task_get", () => {
  test("returns full Task for existing task ID", async () => {
    const { create, get } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Implement auth" });
    expect(r1.ok).toBe(true);
    const id = (r1.task as Record<string, unknown>).id as string;

    const r2 = await exec(get, { task_id: id });
    expect(r2.ok).toBe(true);
    const task = r2.task as Record<string, unknown>;
    expect(task.id).toBe(id);
    expect(task.subject).toBe("Auth");
    // Full task includes timestamps (not in TaskSummary)
    expect(typeof task.createdAt).toBe("number");
  });

  test("returns not-found error for unknown ID", async () => {
    const { get } = await setup();
    const r = await exec(get, { task_id: "nonexistent" });
    expect(r.ok).toBe(false);
    expect(r.error as string).toContain("not found");
  });

  // Zod boundary tests
  test("rejects missing task_id", async () => {
    const { get } = await setup();
    const r = await exec(get, {});
    expect(r.ok).toBe(false);
  });

  test("rejects non-string task_id", async () => {
    const { get } = await setup();
    const r = await exec(get, { task_id: 123 });
    expect(r.ok).toBe(false);
  });

  test("rejects empty string task_id", async () => {
    const { get } = await setup();
    const r = await exec(get, { task_id: "" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// task_update
// ---------------------------------------------------------------------------

describe("task_update", () => {
  test("updates subject and description", async () => {
    const { create, update, get } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Old description" });
    expect(r1.ok).toBe(true);
    const id = (r1.task as Record<string, unknown>).id as string;

    const r2 = await exec(update, { task_id: id, description: "New description" });
    expect(r2.ok).toBe(true);

    const r3 = await exec(get, { task_id: id });
    expect((r3.task as Record<string, unknown>).description).toBe("New description");
  });

  test("status in_progress sets task to in_progress", async () => {
    const { create, update } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;

    const r2 = await exec(update, { task_id: id, status: "in_progress" });
    expect(r2.ok).toBe(true);
    expect((r2.task as Record<string, unknown>).status).toBe("in_progress");
  });

  test("status in_progress with active_form sets activeForm", async () => {
    const { create, update } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;

    const r2 = await exec(update, {
      task_id: id,
      status: "in_progress",
      active_form: "Implementing auth",
    });
    expect(r2.ok).toBe(true);
    expect((r2.task as Record<string, unknown>).activeForm).toBe("Implementing auth");
  });

  // Decision 3A + Test 11A: Single-in-progress enforcement
  test("second task cannot be set to in_progress while one is already running", async () => {
    const { create, update } = await setup();
    const r1 = await exec(create, { subject: "Task A", description: "A" });
    const idA = (r1.task as Record<string, unknown>).id as string;
    const r2 = await exec(create, { subject: "Task B", description: "B" });
    const idB = (r2.task as Record<string, unknown>).id as string;

    const startA = await exec(update, { task_id: idA, status: "in_progress" });
    expect(startA.ok).toBe(true);

    const startB = await exec(update, { task_id: idB, status: "in_progress" });
    expect(startB.ok).toBe(false);
    expect(startB.error as string).toContain("in_progress");
    expect(startB.error as string).toContain(idA);
  });

  test("after completing task A, task B can be started (Test 11A unblock)", async () => {
    const { create, update } = await setup();
    const r1 = await exec(create, { subject: "Task A", description: "A" });
    const idA = (r1.task as Record<string, unknown>).id as string;
    const r2 = await exec(create, { subject: "Task B", description: "B" });
    const idB = (r2.task as Record<string, unknown>).id as string;

    await exec(update, { task_id: idA, status: "in_progress" });
    await exec(update, { task_id: idA, status: "completed", output: "Done A" });

    const startB = await exec(update, { task_id: idB, status: "in_progress" });
    expect(startB.ok).toBe(true);
    expect((startB.task as Record<string, unknown>).status).toBe("in_progress");
  });

  test("after stopping task A, task B can be started (Test 11A stop-then-start)", async () => {
    const { create, update, stop } = await setup();
    const r1 = await exec(create, { subject: "Task A", description: "A" });
    const idA = (r1.task as Record<string, unknown>).id as string;
    const r2 = await exec(create, { subject: "Task B", description: "B" });
    const idB = (r2.task as Record<string, unknown>).id as string;

    await exec(update, { task_id: idA, status: "in_progress" });
    const stopR = await exec(stop, { task_id: idA });
    expect(stopR.ok).toBe(true);

    const startB = await exec(update, { task_id: idB, status: "in_progress" });
    expect(startB.ok).toBe(true);
  });

  test("status completed with output marks task done", async () => {
    const { create, update } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });

    const r2 = await exec(update, { task_id: id, status: "completed", output: "Auth done" });
    expect(r2.ok).toBe(true);
    expect((r2.task as Record<string, unknown>).status).toBe("completed");
  });

  test("status completed without output returns error", async () => {
    const { create, update } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });

    const r2 = await exec(update, { task_id: id, status: "completed" });
    expect(r2.ok).toBe(false);
    expect(r2.error as string).toContain("output");
  });

  test("status failed with reason marks task failed", async () => {
    const { create, update } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });

    const r2 = await exec(update, { task_id: id, status: "failed", reason: "Timeout" });
    expect(r2.ok).toBe(true);
    expect((r2.task as Record<string, unknown>).status).toBe("failed");
  });

  // Zod boundary tests
  test("rejects invalid status value", async () => {
    const { create, update } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    const r2 = await exec(update, { task_id: id, status: "done" });
    expect(r2.ok).toBe(false);
  });

  test("rejects missing task_id", async () => {
    const { update } = await setup();
    const r = await exec(update, { status: "in_progress" });
    expect(r.ok).toBe(false);
  });

  test("rejects non-string task_id", async () => {
    const { update } = await setup();
    const r = await exec(update, { task_id: 999, status: "in_progress" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// task_list
// ---------------------------------------------------------------------------

describe("task_list", () => {
  test("empty board returns empty tasks array", async () => {
    const { list } = await setup();
    const r = await exec(list, {});
    expect(r.ok).toBe(true);
    expect(r.tasks).toEqual([]);
    expect(r.total).toBe(0);
  });

  test("returns TaskSummary projection — no metadata or timestamps", async () => {
    const { create, list } = await setup();
    await exec(create, { subject: "Auth", description: "Do auth" });
    const r = await exec(list, {});
    expect(r.ok).toBe(true);
    const tasks = r.tasks as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
    // TaskSummary has id, subject, status — but no createdAt (timestamp)
    expect(tasks[0]).toHaveProperty("id");
    expect(tasks[0]).toHaveProperty("subject");
    expect(tasks[0]).toHaveProperty("status");
    expect(tasks[0]).not.toHaveProperty("createdAt");
    expect(tasks[0]).not.toHaveProperty("metadata");
  });

  test("filters by status", async () => {
    const { create, update, list } = await setup();
    const r1 = await exec(create, { subject: "A", description: "Task A" });
    await exec(create, { subject: "B", description: "Task B" });
    const idA = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: idA, status: "in_progress" });

    const r = await exec(list, { status: "in_progress" });
    expect(r.ok).toBe(true);
    expect((r.tasks as unknown[]).length).toBe(1);
    expect((r.tasks as Record<string, unknown>[])[0]?.status).toBe("in_progress");
  });

  test("blockedBy populated for blocked tasks", async () => {
    const { create, list } = await setup();
    const r1 = await exec(create, { subject: "A", description: "Task A" });
    const idA = (r1.task as Record<string, unknown>).id as string;
    await exec(create, {
      subject: "B",
      description: "Depends on A",
      dependencies: [idA],
    });

    const r = await exec(list, { status: "pending" });
    expect(r.ok).toBe(true);
    const tasks = r.tasks as Record<string, unknown>[];
    const taskB = tasks.find((t) => t.subject === "B");
    expect(taskB?.blockedBy).toBe(idA);
  });

  // Zod boundary test
  test("rejects invalid status filter", async () => {
    const { list } = await setup();
    const r = await exec(list, { status: "done" });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// task_stop
// ---------------------------------------------------------------------------

describe("task_stop", () => {
  test("stops an in_progress task — board shows killed", async () => {
    const { create, update, stop, get } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });

    const r2 = await exec(stop, { task_id: id });
    expect(r2.ok).toBe(true);

    const r3 = await exec(get, { task_id: id });
    expect((r3.task as Record<string, unknown>).status).toBe("killed");
  });

  test("returns informative error for already-completed task (terminal)", async () => {
    const { create, update, stop } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    await exec(update, { task_id: id, status: "completed", output: "Done" });

    const r2 = await exec(stop, { task_id: id });
    expect(r2.ok).toBe(false);
    expect(r2.error as string).toContain("terminal");
  });

  test("returns error for pending task — not running (Decision 4A)", async () => {
    const { create, stop } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;

    const r2 = await exec(stop, { task_id: id });
    expect(r2.ok).toBe(false);
    expect(r2.error as string).toContain("in_progress");
  });

  test("returns not-found error for unknown task ID", async () => {
    const { stop } = await setup();
    const r = await exec(stop, { task_id: "nonexistent" });
    expect(r.ok).toBe(false);
    expect(r.error as string).toContain("not found");
  });

  // Zod boundary tests
  test("rejects missing task_id", async () => {
    const { stop } = await setup();
    const r = await exec(stop, {});
    expect(r.ok).toBe(false);
  });

  test("rejects non-string task_id", async () => {
    const { stop } = await setup();
    const r = await exec(stop, { task_id: 42 });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// task_output — all 6 states (Decision 9A) + Zod boundary
// ---------------------------------------------------------------------------

describe("task_output", () => {
  test("not_found: unknown task ID", async () => {
    const { output } = await setup();
    const r = (await exec(output, { task_id: "unknown_id" })) as { kind: string; taskId?: string };
    expect(r.kind).toBe("not_found");
    expect(r.taskId).toBe("unknown_id");
  });

  test("pending: task not yet started", async () => {
    const { create, output } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;

    const r = (await exec(output, { task_id: id })) as {
      kind: string;
      task?: Record<string, unknown>;
    };
    expect(r.kind).toBe("pending");
    expect(r.task?.status).toBe("pending");
  });

  test("in_progress: task currently running", async () => {
    const { create, update, output } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });

    const r = (await exec(output, { task_id: id })) as {
      kind: string;
      task?: Record<string, unknown>;
    };
    expect(r.kind).toBe("in_progress");
    expect(r.task?.status).toBe("in_progress");
  });

  test("completed: returns full TaskResult with output", async () => {
    const { create, update, output } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    await exec(update, { task_id: id, status: "completed", output: "Auth done successfully" });

    const r = (await exec(output, { task_id: id })) as {
      kind: string;
      result?: Record<string, unknown>;
    };
    expect(r.kind).toBe("completed");
    expect(r.result?.output).toBe("Auth done successfully");
    expect(typeof r.result?.durationMs).toBe("number");
  });

  test("failed: returns error info", async () => {
    const { create, update, output } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    await exec(update, { task_id: id, status: "failed", reason: "Timeout exceeded" });

    const r = (await exec(output, { task_id: id })) as {
      kind: string;
      task?: Record<string, unknown>;
      error?: Record<string, unknown>;
    };
    expect(r.kind).toBe("failed");
    expect(r.error?.message).toBe("Timeout exceeded");
  });

  test("killed: returns killed task info", async () => {
    const { create, update, stop, output } = await setup();
    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    await exec(stop, { task_id: id });

    const r = (await exec(output, { task_id: id })) as {
      kind: string;
      task?: Record<string, unknown>;
    };
    expect(r.kind).toBe("killed");
    expect(r.task?.status).toBe("killed");
  });

  test("completion blocked when board has no durable result storage", async () => {
    // Board without resultsDir: task_update(status: completed) must fail fast
    // rather than silently losing output after a restart (data-loss prevention).
    const store = createMemoryTaskBoardStore();
    const boardNoResults = await createManagedTaskBoard({ store }); // no resultsDir
    const t = createTaskTools({ board: boardNoResults, agentId: agentId("agent-1") });
    if (t.length < 6) throw new Error("Expected 6 tools");
    const [create, , update] = t as [Tool, Tool, Tool, Tool, Tool, Tool];

    const r1 = await exec(create, { subject: "Auth", description: "Do auth" });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });

    const r2 = await exec(update, { task_id: id, status: "completed", output: "Done" });
    expect(r2.ok).toBe(false);
    expect(r2.error as string).toContain("resultsDir");
  });

  // Zod boundary tests
  test("rejects missing task_id", async () => {
    const { output } = await setup();
    const r = await exec(output, {});
    expect(r.ok).toBe(false);
  });

  test("rejects non-string task_id", async () => {
    const { output } = await setup();
    const r = await exec(output, { task_id: true });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verification nudge (Decision 10A) — full counter state machine
// ---------------------------------------------------------------------------

describe("verification nudge", () => {
  async function setupWithTools(): Promise<{
    update: Tool;
    create: Tool;
  }> {
    const store = createMemoryTaskBoardStore();
    const resultsDir = await freshResultsDir();
    const board = await createManagedTaskBoard({ store, resultsDir });
    const tools = createTaskTools({ board, agentId: agentId("agent-1") });
    if (tools.length < 6) throw new Error("Expected 6 tools");
    const [create, , update] = tools as [Tool, Tool, Tool, Tool, Tool, Tool];
    return { create, update };
  }

  async function completeTask(
    create: Tool,
    update: Tool,
    subject: string,
  ): Promise<Record<string, unknown>> {
    const r1 = await exec(create, { subject, description: subject });
    const id = (r1.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    return exec(update, { task_id: id, status: "completed", output: "done" });
  }

  test("1 non-verif completion — no nudge", async () => {
    const { create, update } = await setupWithTools();
    const r = await completeTask(create, update, "Implement auth");
    expect(r.ok).toBe(true);
    expect(r.nudge).toBeUndefined();
  });

  test("2 non-verif completions — no nudge", async () => {
    const { create, update } = await setupWithTools();
    await completeTask(create, update, "Task 1");
    const r = await completeTask(create, update, "Task 2");
    expect(r.nudge).toBeUndefined();
  });

  test("3 non-verif completions — nudge fires", async () => {
    const { create, update } = await setupWithTools();
    await completeTask(create, update, "Task 1");
    await completeTask(create, update, "Task 2");
    const r = await completeTask(create, update, "Task 3");
    expect(r.ok).toBe(true);
    expect(typeof r.nudge).toBe("string");
    expect(r.nudge as string).toContain("verif");
  });

  test("4th non-verif completion — nudge still fires (fires on 3+, not exactly 3)", async () => {
    const { create, update } = await setupWithTools();
    await completeTask(create, update, "Task 1");
    await completeTask(create, update, "Task 2");
    await completeTask(create, update, "Task 3");
    const r = await completeTask(create, update, "Task 4");
    expect(typeof r.nudge).toBe("string");
  });

  test("completing a verif task resets counter — next 2 non-verif completions no nudge", async () => {
    const { create, update } = await setupWithTools();
    // Build up counter to 2
    await completeTask(create, update, "Task 1");
    await completeTask(create, update, "Task 2");
    // Complete a verif task — resets counter
    await completeTask(create, update, "Verify implementation");
    // Should be 0 now — next 2 completions without nudge
    const r1 = await completeTask(create, update, "Task 3");
    expect(r1.nudge).toBeUndefined();
    const r2 = await completeTask(create, update, "Task 4");
    expect(r2.nudge).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// task_delegate
// ---------------------------------------------------------------------------

describe("task_delegate", () => {
  test("delegates a pending task to a child agent", async () => {
    const { create, delegate } = await setup();
    const r = await exec(create, { subject: "Auth module", description: "Implement OAuth2" });
    expect(r.ok).toBe(true);
    const id = (r.task as Record<string, unknown>).id as string;

    const dr = await exec(delegate, { task_id: id, agent_id: "child-agent-1" });
    expect(dr.ok).toBe(true);
    const task = dr.task as Record<string, unknown>;
    expect(task.status).toBe("in_progress");
    expect(task.assignedTo).toBe("child-agent-1");
  });

  test("allows N tasks to be delegated simultaneously without in_progress conflict", async () => {
    const { create, delegate } = await setup();
    const r1 = await exec(create, { subject: "Task A", description: "First" });
    const r2 = await exec(create, { subject: "Task B", description: "Second" });
    const r3 = await exec(create, { subject: "Task C", description: "Third" });
    const id1 = (r1.task as Record<string, unknown>).id as string;
    const id2 = (r2.task as Record<string, unknown>).id as string;
    const id3 = (r3.task as Record<string, unknown>).id as string;

    const d1 = await exec(delegate, { task_id: id1, agent_id: "child-1" });
    const d2 = await exec(delegate, { task_id: id2, agent_id: "child-2" });
    const d3 = await exec(delegate, { task_id: id3, agent_id: "child-3" });

    expect(d1.ok).toBe(true);
    expect(d2.ok).toBe(true);
    expect(d3.ok).toBe(true);
    expect((d1.task as Record<string, unknown>).status).toBe("in_progress");
    expect((d2.task as Record<string, unknown>).status).toBe("in_progress");
    expect((d3.task as Record<string, unknown>).status).toBe("in_progress");
  });

  test("rejects a task that is already in_progress (already delegated)", async () => {
    const { create, delegate } = await setup();
    const r = await exec(create, { subject: "Task", description: "Desc" });
    const id = (r.task as Record<string, unknown>).id as string;
    await exec(delegate, { task_id: id, agent_id: "child-1" });

    // Second delegation attempt on same task
    const dr = await exec(delegate, { task_id: id, agent_id: "child-2" });
    expect(dr.ok).toBe(false);
    expect(typeof dr.error).toBe("string");
  });

  test("returns error for unknown task_id", async () => {
    const { delegate } = await setup();
    const r = await exec(delegate, { task_id: "nonexistent_99", agent_id: "child-1" });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  test("rejects invalid args — missing agent_id", async () => {
    const { delegate } = await setup();
    const r = await exec(delegate, { task_id: "task_1" });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// task_update regression — single-in-progress guard still active after delegation
// ---------------------------------------------------------------------------

describe("task_update regression — in_progress guard survives delegation", () => {
  test("task_update cannot start a second task when one is already delegated", async () => {
    const { create, update, delegate } = await setup();
    const r1 = await exec(create, { subject: "Delegated task", description: "Delegated" });
    const r2 = await exec(create, { subject: "Worker task", description: "For worker" });
    const id1 = (r1.task as Record<string, unknown>).id as string;
    const id2 = (r2.task as Record<string, unknown>).id as string;

    // Delegate task 1 to a child — it's now in_progress
    await exec(delegate, { task_id: id1, agent_id: "child-1" });

    // task_update trying to claim task 2 as in_progress should fail
    const ur = await exec(update, { task_id: id2, status: "in_progress" });
    expect(ur.ok).toBe(false);
    expect(String(ur.error)).toMatch(/in_progress/);
  });
});

// ---------------------------------------------------------------------------
// task_list — updated_since filter
// ---------------------------------------------------------------------------

describe("task_list — updated_since filter", () => {
  test("returns only tasks updated after the given timestamp", async () => {
    const { create, list } = await setup();
    await exec(create, { subject: "Old A", description: "Created before cutoff" });
    await exec(create, { subject: "Old B", description: "Created before cutoff" });

    const cutoff = Date.now();
    // Brief pause to ensure updatedAt > cutoff for the new task
    await new Promise((res) => setTimeout(res, 5));

    await exec(create, { subject: "New C", description: "Created after cutoff" });

    const r = await exec(list, { updated_since: cutoff });
    expect(r.ok).toBe(true);
    const tasks = r.tasks as readonly Record<string, unknown>[];
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.subject).toBe("New C");
  });

  test("returns all tasks when updated_since is 0", async () => {
    const { create, list } = await setup();
    await exec(create, { subject: "A", description: "Desc" });
    await exec(create, { subject: "B", description: "Desc" });
    const r = await exec(list, { updated_since: 0 });
    expect(r.ok).toBe(true);
    expect((r.tasks as unknown[]).length).toBe(2);
  });

  test("existing filters still work alongside updated_since", async () => {
    const { create, update, list } = await setup();
    await exec(create, { subject: "Old pending", description: "Desc" });
    const cutoff = Date.now();
    await new Promise((res) => setTimeout(res, 5));
    await exec(create, { subject: "New pending", description: "Desc" });
    // Complete a task so there's one non-pending task after the cutoff
    const rc = await exec(create, { subject: "New task to complete", description: "Desc" });
    const id = (rc.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    await exec(update, { task_id: id, status: "completed", output: "Done" });

    const r = await exec(list, { updated_since: cutoff, status: "pending" });
    expect(r.ok).toBe(true);
    const tasks = r.tasks as readonly Record<string, unknown>[];
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.subject).toBe("New pending");
  });
});

// ---------------------------------------------------------------------------
// task_output — resultSchemas validation
// ---------------------------------------------------------------------------

describe("task_output — resultSchemas validation", () => {
  async function setupWithSchema(): Promise<
    ToolSet & { boardRef: import("@koi/core").ManagedTaskBoard }
  > {
    const store = createMemoryTaskBoardStore();
    const resultsDir = await freshResultsDir();
    const board = await createManagedTaskBoard({ store, resultsDir });
    const tools = createTaskTools({
      board,
      agentId: agentId("agent-1"),
      resultSchemas: {
        research: z.object({ count: z.number(), summary: z.string() }),
      },
    });
    if (tools.length < 7) throw new Error("Expected 7 task tools");
    const [create, get, update, list, stop, output, delegate] = tools as [
      Tool,
      Tool,
      Tool,
      Tool,
      Tool,
      Tool,
      Tool,
    ];
    return { tools, create, get, update, list, stop, output, delegate, boardRef: board };
  }

  test("returns completed result with no error when results match schema", async () => {
    const { create, update, output } = await setupWithSchema();
    const rc = await exec(create, {
      subject: "Research task",
      description: "Research something",
      metadata: { kind: "research" },
    });
    const id = (rc.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    await exec(update, {
      task_id: id,
      status: "completed",
      output: "Done",
      results: { count: 5, summary: "Found 5 items" },
    });

    const r = await exec(output, { task_id: id });
    expect(r.kind).toBe("completed");
    expect(r.resultsValidationError).toBeUndefined();
  });

  test("returns resultsValidationError when results do not match schema", async () => {
    const { create, update, output } = await setupWithSchema();
    const rc = await exec(create, {
      subject: "Research task",
      description: "Research something",
      metadata: { kind: "research" },
    });
    const id = (rc.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    await exec(update, {
      task_id: id,
      status: "completed",
      output: "Done",
      results: { count: "not-a-number", summary: "Bad" },
    });

    const r = await exec(output, { task_id: id });
    expect(r.kind).toBe("completed");
    expect(typeof r.resultsValidationError).toBe("string");
  });

  test("no validation when task has no metadata.kind", async () => {
    const { create, update, output } = await setupWithSchema();
    const rc = await exec(create, { subject: "Generic task", description: "No kind" });
    const id = (rc.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    await exec(update, {
      task_id: id,
      status: "completed",
      output: "Done",
      results: { anything: "goes" },
    });

    const r = await exec(output, { task_id: id });
    expect(r.kind).toBe("completed");
    expect(r.resultsValidationError).toBeUndefined();
  });

  test("no validation when resultSchemas not configured", async () => {
    const { create, update, output } = await setup();
    const rc = await exec(create, {
      subject: "Task",
      description: "Desc",
      metadata: { kind: "research" },
    });
    const id = (rc.task as Record<string, unknown>).id as string;
    await exec(update, { task_id: id, status: "in_progress" });
    await exec(update, {
      task_id: id,
      status: "completed",
      output: "Done",
      results: { anything: "goes" },
    });

    const r = await exec(output, { task_id: id });
    expect(r.kind).toBe("completed");
    expect(r.resultsValidationError).toBeUndefined();
  });
});
