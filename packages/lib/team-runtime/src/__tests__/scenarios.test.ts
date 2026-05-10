import { describe, expect, test } from "bun:test";
import type { TeamEvent } from "../events.js";
import { planRunnableTasks } from "../planner.js";
import { createTeamRuntime } from "../runtime.js";
import { reduceTeamEvents, type TeamRuntimeSnapshot } from "../state.js";

interface SimAgent {
  readonly agentId: string;
}

interface SimTaskSpec {
  readonly taskId: string;
  readonly subject?: string;
  readonly dependencies?: readonly string[];
  readonly sharedResources?: readonly string[];
}

let eventCounter = 0;
function nextEventId(prefix: string): string {
  eventCounter += 1;
  return `${prefix}_${eventCounter}`;
}

function buildInitialEvents(teamRunId: string, tasks: readonly SimTaskSpec[]): TeamEvent[] {
  const events: TeamEvent[] = [
    {
      kind: "team.created",
      eventId: nextEventId("team"),
      teamRunId,
      timestamp: 0,
      payload: { specName: teamRunId },
    },
  ];
  for (const task of tasks) {
    events.push({
      kind: "task.added",
      eventId: nextEventId("add"),
      teamRunId,
      timestamp: events.length,
      taskId: task.taskId,
      payload: {
        subject: task.subject ?? task.taskId,
        description: task.subject ?? task.taskId,
        dependencies: task.dependencies ?? [],
        sharedResources: task.sharedResources,
      },
    });
  }
  return events;
}

interface DriverResult {
  readonly events: readonly TeamEvent[];
  readonly snapshots: readonly TeamRuntimeSnapshot[];
  readonly waves: readonly (readonly string[])[];
}

/**
 * Scheduler-loop driver: alternates plan → assign → complete until quiet.
 * One "wave" = a single planRunnableTasks() call; each runnable task is
 * dispatched to an available agent and immediately completed.
 */
function driveToCompletion(
  initial: readonly TeamEvent[],
  agents: readonly SimAgent[],
  options: { readonly maxWaves?: number } = {},
): DriverResult {
  const maxWaves = options.maxWaves ?? 100;
  const events = [...initial];
  const snapshots: TeamRuntimeSnapshot[] = [];
  const waves: string[][] = [];
  const teamRunId = initial[0]?.teamRunId ?? "";

  for (let wave = 0; wave < maxWaves; wave += 1) {
    const snapshot = reduceTeamEvents(events);
    snapshots.push(snapshot);
    const runnable = planRunnableTasks(snapshot).slice(0, agents.length);
    if (runnable.length === 0) break;

    waves.push(runnable.map((task) => task.taskId));

    runnable.forEach((task, index) => {
      const agent = agents[index];
      if (!agent) return;
      events.push({
        kind: "task.assigned",
        eventId: nextEventId("assign"),
        teamRunId,
        timestamp: events.length,
        taskId: task.taskId,
        agentId: agent.agentId,
        payload: { sharedResources: task.sharedResources },
      });
      events.push({
        kind: "task.completed",
        eventId: nextEventId("done"),
        teamRunId,
        timestamp: events.length,
        taskId: task.taskId,
        agentId: agent.agentId,
        payload: { output: `output:${task.taskId}` },
      });
    });
  }

  return { events, snapshots, waves };
}

describe("Scenario: fan-out / fan-in", () => {
  test("N independent tasks form one wave; merge runs after all complete", () => {
    const events = buildInitialEvents("fanout", [
      { taskId: "task_a", dependencies: [] },
      { taskId: "task_b", dependencies: [] },
      { taskId: "task_c", dependencies: [] },
      { taskId: "task_merge", dependencies: ["task_a", "task_b", "task_c"] },
    ]);

    const { waves, snapshots } = driveToCompletion(events, [
      { agentId: "w1" },
      { agentId: "w2" },
      { agentId: "w3" },
    ]);

    expect(waves[0]?.toSorted()).toEqual(["task_a", "task_b", "task_c"]);
    expect(waves[1]).toEqual(["task_merge"]);
    const final = snapshots.at(-1);
    expect(final?.board.all().every((task) => task.status === "completed")).toBe(true);
  });
});

describe("Scenario: dependency chain", () => {
  test("A→B→C→D releases one task per wave", () => {
    const events = buildInitialEvents("chain", [
      { taskId: "task_a", dependencies: [] },
      { taskId: "task_b", dependencies: ["task_a"] },
      { taskId: "task_c", dependencies: ["task_b"] },
      { taskId: "task_d", dependencies: ["task_c"] },
    ]);

    const { waves } = driveToCompletion(events, [
      { agentId: "w1" },
      { agentId: "w2" },
      { agentId: "w3" },
    ]);

    expect(waves).toEqual([["task_a"], ["task_b"], ["task_c"], ["task_d"]]);
  });
});

describe("Scenario: resource serialization", () => {
  test("two tasks competing for the same resource never run concurrently", () => {
    const events = buildInitialEvents("resources", [
      { taskId: "task_a", sharedResources: ["pkg/foo.ts"] },
      { taskId: "task_b", sharedResources: ["pkg/foo.ts"] },
      { taskId: "task_c", sharedResources: ["pkg/bar.ts"] },
    ]);

    const { waves } = driveToCompletion(events, [
      { agentId: "w1" },
      { agentId: "w2" },
      { agentId: "w3" },
    ]);

    // First wave: a and c (different resources). Second wave: b.
    expect(waves[0]?.toSorted()).toEqual(["task_a", "task_c"]);
    expect(waves[1]).toEqual(["task_b"]);
  });

  test("diamond with shared resources serializes overlap correctly", () => {
    const events = buildInitialEvents("diamond", [
      { taskId: "root", sharedResources: [] },
      { taskId: "left", dependencies: ["root"], sharedResources: ["x"] },
      { taskId: "right", dependencies: ["root"], sharedResources: ["x"] },
      { taskId: "merge", dependencies: ["left", "right"] },
    ]);

    const { waves } = driveToCompletion(events, [{ agentId: "w1" }, { agentId: "w2" }]);

    expect(waves[0]).toEqual(["root"]);
    expect(waves[1]?.length).toBe(1);
    const secondTask = waves[1]?.[0] ?? "";
    expect(["left", "right"]).toContain(secondTask);
    expect(waves[2]?.length).toBe(1);
    expect(waves.at(-1)).toEqual(["merge"]);
  });
});

describe("Scenario: crash recovery", () => {
  test("crashed task returns to pending and releases its resources", () => {
    const events: TeamEvent[] = [
      ...buildInitialEvents("crash", [
        { taskId: "task_a", sharedResources: ["lockfile"] },
        { taskId: "task_b", sharedResources: ["lockfile"] },
      ]),
    ];
    const teamRunId = "crash";
    events.push({
      kind: "task.assigned",
      eventId: nextEventId("assign"),
      teamRunId,
      timestamp: events.length,
      taskId: "task_a",
      agentId: "worker-1",
      payload: {},
    });

    const midSnapshot = reduceTeamEvents(events);
    expect(midSnapshot.activeResources.has("lockfile")).toBe(true);
    expect(planRunnableTasks(midSnapshot).map((task) => task.taskId)).toEqual([]);

    events.push({
      kind: "task.crash_detected",
      eventId: nextEventId("crash"),
      teamRunId,
      timestamp: events.length,
      taskId: "task_a",
      agentId: "worker-1",
      payload: {},
    });

    const recovered = reduceTeamEvents(events);
    expect(recovered.activeResources.has("lockfile")).toBe(false);
    expect(recovered.board.get("task_a")?.status).toBe("pending");
    // Either task can be picked up first now — both are runnable and contend.
    expect(planRunnableTasks(recovered).length).toBe(1);
  });
});

describe("Scenario: resume from event log", () => {
  test("persisted snapshot replays into identical state", async () => {
    const runtime = createTeamRuntime(
      {
        name: "resume-team",
        agents: [{ agentType: "coder" }],
        budget: { total: 100 },
        workspacePolicy: { mode: "isolated" },
      },
      {
        idFactory: () => "resume-1",
      },
    );

    const handle = await runtime.start({ goal: "anything" });
    const persisted = handle.getSnapshot().events;

    const restored = await runtime.resume({ events: persisted });
    expect(restored.teamRunId).toBe(handle.teamRunId);
    expect(restored.getSnapshot().events).toEqual(persisted);
  });
});

describe("Scenario: at-least-once delivery idempotence", () => {
  test("duplicating every event 3x produces an equivalent snapshot", () => {
    const base = buildInitialEvents("idem", [
      { taskId: "task_a" },
      { taskId: "task_b", dependencies: ["task_a"] },
    ]);
    const teamRunId = "idem";
    base.push(
      {
        kind: "task.assigned",
        eventId: nextEventId("assign"),
        teamRunId,
        timestamp: base.length,
        taskId: "task_a",
        agentId: "w1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: nextEventId("done"),
        teamRunId,
        timestamp: base.length + 1,
        taskId: "task_a",
        agentId: "w1",
        payload: { output: "ok" },
      },
    );

    const single = reduceTeamEvents(base);
    const tripled = reduceTeamEvents([...base, ...base, ...base]);

    expect(tripled.board.all()).toEqual(single.board.all());
    expect([...tripled.outputs]).toEqual([...single.outputs]);
    expect([...tripled.activeAssignments]).toEqual([...single.activeAssignments]);
  });
});

describe("Scenario: mixed-version legacy stream", () => {
  test("sharedResources arriving only on task.completed are hydrated", () => {
    const events = buildInitialEvents("legacy", [{ taskId: "task_a" }]);
    const teamRunId = "legacy";
    events.push(
      {
        kind: "task.assigned",
        eventId: nextEventId("assign"),
        teamRunId,
        timestamp: events.length,
        taskId: "task_a",
        agentId: "w1",
        payload: {},
      },
      {
        kind: "task.completed",
        eventId: nextEventId("done"),
        teamRunId,
        timestamp: events.length + 1,
        taskId: "task_a",
        agentId: "w1",
        payload: { output: "ok", sharedResources: ["pkg/foo.ts"] },
      },
    );

    const snapshot = reduceTeamEvents(events);
    expect(snapshot.board.get("task_a")?.sharedResources).toEqual(["pkg/foo.ts"]);
  });
});

describe("Scenario: detached snapshots", () => {
  test("mutating returned task arrays cannot leak into snapshot", () => {
    const events = buildInitialEvents("detach", [{ taskId: "task_a", sharedResources: ["res-1"] }]);
    const snapshot = reduceTeamEvents(events);
    const task = snapshot.board.all()[0];
    if (task !== undefined) {
      (task.dependencies as unknown as string[]).push("hacked");
      const resources = task.sharedResources;
      if (resources) (resources as unknown as string[]).push("hacked");
    }
    const reread = snapshot.board.get("task_a");
    expect(reread?.dependencies).toEqual([]);
    expect(reread?.sharedResources).toEqual(["res-1"]);
  });
});

describe("Scenario: self-dependency cycle", () => {
  test("a task that depends on itself is reported as blocked, not thrown", () => {
    const snapshot = reduceTeamEvents([
      ...buildInitialEvents("self", []),
      {
        kind: "task.added",
        eventId: nextEventId("add"),
        teamRunId: "self",
        timestamp: 1,
        taskId: "task_self",
        payload: { subject: "S", description: "S", dependencies: ["task_self"] },
      },
    ]);

    expect(snapshot.blockedTaskIds).toContain("task_self");
    expect(planRunnableTasks(snapshot)).toEqual([]);
  });
});

describe("Scenario: concurrent start() calls", () => {
  test("Promise.all of 10 starts produces 10 distinct teamRunIds", async () => {
    let counter = 0;
    const runtime = createTeamRuntime(
      {
        name: "concurrent",
        agents: [{ agentType: "coder" }],
        budget: { total: 100 },
        workspacePolicy: { mode: "isolated" },
      },
      {
        idFactory: () => {
          counter += 1;
          return `concurrent-${counter}`;
        },
      },
    );

    const handles = await Promise.all(
      Array.from({ length: 10 }, (_, index) => runtime.start({ goal: `g${index}` })),
    );
    const ids = new Set(handles.map((handle) => handle.teamRunId));
    expect(ids.size).toBe(10);
  });
});
