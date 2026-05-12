import { describe, expect, test } from "bun:test";
import type { TeamEvent } from "../events.js";
import { planRunnableTasks } from "../planner.js";
import { reduceTeamEvents } from "../state.js";

/**
 * Tiny seeded PRNG so failures are reproducible.
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GeneratedScenario {
  readonly events: readonly TeamEvent[];
  readonly taskIds: readonly string[];
}

function generateScenario(seed: number, taskCount: number): GeneratedScenario {
  const random = mulberry32(seed);
  const teamRunId = `prop-${seed}`;
  const taskIds = Array.from({ length: taskCount }, (_, index) => `t${index}`);
  const events: TeamEvent[] = [
    {
      kind: "team.created",
      eventId: `team:${seed}`,
      teamRunId,
      timestamp: 0,
      payload: { specName: teamRunId },
    },
  ];

  // Acyclic deps: each task can depend only on earlier-indexed tasks.
  for (let index = 0; index < taskCount; index += 1) {
    const dependencies: string[] = [];
    for (let prior = 0; prior < index; prior += 1) {
      if (random() < 0.3) dependencies.push(`t${prior}`);
    }
    const resources: string[] = [];
    if (random() < 0.5) resources.push(`r${Math.floor(random() * 3)}`);
    events.push({
      kind: "task.added",
      eventId: `add:${seed}:${index}`,
      teamRunId,
      timestamp: events.length,
      taskId: `t${index}`,
      payload: {
        subject: `t${index}`,
        description: `t${index}`,
        dependencies,
        sharedResources: resources.length > 0 ? resources : undefined,
      },
    });
  }

  return { events, taskIds };
}

function driveToCompletion(events: readonly TeamEvent[], teamRunId: string): TeamEvent[] {
  const log = [...events];
  let agentCounter = 0;
  for (let safety = 0; safety < 200; safety += 1) {
    const snapshot = reduceTeamEvents(log);
    const runnable = planRunnableTasks(snapshot);
    if (runnable.length === 0) break;
    for (const task of runnable) {
      agentCounter += 1;
      const agentId = `agent-${agentCounter}`;
      log.push({
        kind: "task.assigned",
        eventId: `assign:${log.length}`,
        teamRunId,
        timestamp: log.length,
        taskId: task.taskId,
        agentId,
        payload: { sharedResources: task.sharedResources },
      });
      log.push({
        kind: "task.completed",
        eventId: `done:${log.length}`,
        teamRunId,
        timestamp: log.length,
        taskId: task.taskId,
        agentId,
        payload: { output: `done:${task.taskId}` },
      });
    }
  }
  return log;
}

describe("Property: reducer is deterministic across calls", () => {
  test("reducing the same events twice yields identical board state", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const { events } = generateScenario(seed, 6);
      const a = reduceTeamEvents(events);
      const b = reduceTeamEvents(events);
      expect(a.board.all()).toEqual(b.board.all());
      expect([...a.outputs]).toEqual([...b.outputs]);
      expect([...a.activeAssignments]).toEqual([...b.activeAssignments]);
      expect([...a.activeResources].toSorted()).toEqual([...b.activeResources].toSorted());
      expect(a.blockedTaskIds.toSorted()).toEqual(b.blockedTaskIds.toSorted());
    }
  });
});

describe("Property: planner output never contains blocked tasks", () => {
  test("blockedTaskIds and planRunnableTasks are disjoint", () => {
    for (let seed = 100; seed <= 130; seed += 1) {
      const { events } = generateScenario(seed, 6);
      const snapshot = reduceTeamEvents(events);
      const blocked = new Set(snapshot.blockedTaskIds);
      for (const task of planRunnableTasks(snapshot)) {
        expect(blocked.has(task.taskId)).toBe(false);
      }
    }
  });
});

describe("Property: planner output has disjoint shared resources", () => {
  test("any two runnable tasks in one wave share no resource", () => {
    for (let seed = 200; seed <= 230; seed += 1) {
      const { events } = generateScenario(seed, 8);
      const snapshot = reduceTeamEvents(events);
      const runnable = planRunnableTasks(snapshot);
      const seen = new Set<string>();
      for (const task of runnable) {
        for (const resource of task.sharedResources ?? []) {
          expect(seen.has(resource)).toBe(false);
          seen.add(resource);
        }
      }
    }
  });
});

describe("Property: completed runs cover all tasks", () => {
  test("driving to quiescence completes every non-blocked task", () => {
    for (let seed = 300; seed <= 330; seed += 1) {
      const { events, taskIds } = generateScenario(seed, 6);
      const teamRunId = `prop-${seed}`;
      const finalEvents = driveToCompletion(events, teamRunId);
      const final = reduceTeamEvents(finalEvents);
      const blocked = new Set(final.blockedTaskIds);
      for (const taskId of taskIds) {
        if (blocked.has(taskId)) continue;
        expect(final.board.get(taskId)?.status).toBe("completed");
      }
    }
  });
});

describe("Property: dependencies always complete before dependents", () => {
  test("for every completed task, all its dependencies completed at an earlier wave", () => {
    for (let seed = 400; seed <= 420; seed += 1) {
      const { events } = generateScenario(seed, 6);
      const teamRunId = `prop-${seed}`;
      const finalEvents = driveToCompletion(events, teamRunId);

      const completionTimestamp = new Map<string, number>();
      for (const event of finalEvents) {
        if (event.kind === "task.completed") {
          completionTimestamp.set(event.taskId, event.timestamp);
        }
      }

      const final = reduceTeamEvents(finalEvents);
      for (const task of final.board.all()) {
        if (task.status !== "completed") continue;
        const taskTime = completionTimestamp.get(task.taskId);
        expect(taskTime).toBeDefined();
        for (const dep of task.dependencies) {
          const depTime = completionTimestamp.get(dep);
          if (depTime !== undefined && taskTime !== undefined) {
            expect(depTime).toBeLessThan(taskTime);
          }
        }
      }
    }
  });
});

describe("Property: crash recovery releases held resources", () => {
  test("after task.crash_detected, the task's resources never appear in activeResources", () => {
    const teamRunId = "crash-prop";
    const events: TeamEvent[] = [
      {
        kind: "team.created",
        eventId: "team",
        teamRunId,
        timestamp: 0,
        payload: { specName: teamRunId },
      },
      {
        kind: "task.added",
        eventId: "add",
        teamRunId,
        timestamp: 1,
        taskId: "t",
        payload: {
          subject: "T",
          description: "T",
          dependencies: [],
          sharedResources: ["r1", "r2"],
        },
      },
      {
        kind: "task.assigned",
        eventId: "assign",
        teamRunId,
        timestamp: 2,
        taskId: "t",
        agentId: "a",
        payload: {},
      },
      {
        kind: "task.crash_detected",
        eventId: "crash",
        teamRunId,
        timestamp: 3,
        taskId: "t",
        agentId: "a",
        payload: {},
      },
    ];
    const snapshot = reduceTeamEvents(events);
    expect(snapshot.activeResources.size).toBe(0);
    expect(snapshot.activeAssignments.has("t")).toBe(false);
    expect(snapshot.board.get("t")?.status).toBe("pending");
  });
});
