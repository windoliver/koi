import { describe, expect, test } from "bun:test";
import type { AgentId, JsonObject, ZoneId } from "@koi/core";
import { createLocalMailbox, createLocalMailboxRouter } from "@koi/ipc-local";
import type { SwarmFederationBridge, SwarmTask } from "./index.js";
import { createSwarmCoordinator } from "./index.js";

function agentId(value: string): AgentId {
  return value as AgentId;
}

function zoneId(value: string): ZoneId {
  return value as ZoneId;
}

function task(id: string, requiredCapabilities: readonly string[] = []): SwarmTask {
  return {
    id,
    subject: `Task ${id}`,
    description: `Do task ${id}`,
    requiredCapabilities,
  };
}

function createBridge(): {
  readonly bridge: SwarmFederationBridge;
  readonly events: readonly JsonObject[];
} {
  const events: JsonObject[] = [];
  return {
    events,
    bridge: {
      publish: async (event) => {
        events.push(event);
        return { ok: true };
      },
    },
  };
}

describe("createSwarmCoordinator", () => {
  test("same-node team communicates via ipc-local mailboxes", async () => {
    const router = createLocalMailboxRouter();
    const leadMailbox = createLocalMailbox({ agentId: agentId("lead"), router });
    const workerMailbox = createLocalMailbox({ agentId: agentId("worker"), router });
    router.register(agentId("lead"), leadMailbox);
    router.register(agentId("worker"), workerMailbox);
    const coordinator = createSwarmCoordinator({
      localZoneId: zoneId("local"),
    });
    coordinator.registerTeam({
      teamId: "alpha",
      leadAgentId: agentId("lead"),
      zoneId: zoneId("local"),
      leadMailbox,
    });
    coordinator.registerMember({
      teamId: "alpha",
      agentId: agentId("worker"),
      capabilities: ["code"],
      mailbox: workerMailbox,
    });

    const assigned = await coordinator.distributeTask("alpha", task("t1", ["code"]), {
      strategy: "capability",
    });

    expect(assigned).toEqual({ ok: true, value: agentId("worker") });
    const inbox = await workerMailbox.list({ type: "swarm.task.assigned" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.from).toBe(agentId("lead"));
    expect(inbox[0]?.payload.taskId).toBe("t1");
  });

  test("cross-node team publishes assignments through the optional federation bridge", async () => {
    const { bridge, events } = createBridge();
    const coordinator = createSwarmCoordinator({
      localZoneId: zoneId("local"),
      federation: bridge,
    });
    coordinator.registerTeam({
      teamId: "remote-team",
      leadAgentId: agentId("remote-lead"),
      zoneId: zoneId("remote"),
    });
    coordinator.registerMember({
      teamId: "remote-team",
      agentId: agentId("remote-worker"),
      capabilities: ["research"],
      zoneId: zoneId("remote"),
      load: 2,
    });

    const assigned = await coordinator.distributeTask(
      "remote-team",
      task("remote-1", ["research"]),
      {
        strategy: "load",
      },
    );

    expect(assigned).toEqual({ ok: true, value: agentId("remote-worker") });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "swarm.task.assigned",
      targetZoneId: "remote",
      teamId: "remote-team",
      agentId: "remote-worker",
      taskId: "remote-1",
    });
  });

  test("distributes tasks by round-robin, capability, and load", async () => {
    const coordinator = createSwarmCoordinator({ localZoneId: zoneId("local") });
    coordinator.registerTeam({
      teamId: "alpha",
      leadAgentId: agentId("lead"),
      zoneId: zoneId("local"),
    });
    coordinator.registerMember({
      teamId: "alpha",
      agentId: agentId("researcher"),
      capabilities: ["research"],
      load: 4,
    });
    coordinator.registerMember({
      teamId: "alpha",
      agentId: agentId("coder"),
      capabilities: ["code", "test"],
      load: 1,
    });

    await expect(
      coordinator.distributeTask("alpha", task("rr-1"), { strategy: "round-robin" }),
    ).resolves.toEqual({ ok: true, value: agentId("researcher") });
    await expect(
      coordinator.distributeTask("alpha", task("rr-2"), { strategy: "round-robin" }),
    ).resolves.toEqual({ ok: true, value: agentId("coder") });
    await expect(
      coordinator.distributeTask("alpha", task("cap", ["test"]), { strategy: "capability" }),
    ).resolves.toEqual({ ok: true, value: agentId("coder") });
    await expect(
      coordinator.distributeTask("alpha", task("load"), { strategy: "load" }),
    ).resolves.toEqual({ ok: true, value: agentId("coder") });
  });

  test("tracks progress per teammate", () => {
    const coordinator = createSwarmCoordinator({ localZoneId: zoneId("local") });
    coordinator.registerTeam({
      teamId: "alpha",
      leadAgentId: agentId("lead"),
      zoneId: zoneId("local"),
    });
    coordinator.registerMember({
      teamId: "alpha",
      agentId: agentId("worker"),
      capabilities: ["code"],
    });

    expect(
      coordinator.updateProgress({
        teamId: "alpha",
        agentId: agentId("worker"),
        taskId: "t1",
        status: "in_progress",
        note: "coding",
        completedUnits: 2,
        totalUnits: 5,
      }),
    ).toEqual({ ok: true });

    expect(coordinator.getProgress("alpha", agentId("worker"))).toEqual({
      teamId: "alpha",
      agentId: agentId("worker"),
      taskId: "t1",
      status: "in_progress",
      note: "coding",
      completedUnits: 2,
      totalUnits: 5,
    });
  });

  test("team-wide abort stops all team members", async () => {
    const aborted: string[] = [];
    const coordinator = createSwarmCoordinator({
      localZoneId: zoneId("local"),
      abortMember: async ({ agentId }) => {
        aborted.push(agentId);
        return { ok: true };
      },
    });
    coordinator.registerTeam({
      teamId: "alpha",
      leadAgentId: agentId("lead"),
      zoneId: zoneId("local"),
    });
    coordinator.registerMember({
      teamId: "alpha",
      agentId: agentId("one"),
      capabilities: ["code"],
    });
    coordinator.registerMember({
      teamId: "alpha",
      agentId: agentId("two"),
      capabilities: ["test"],
    });

    await expect(coordinator.abortTeam("alpha", "stop requested")).resolves.toEqual({ ok: true });
    expect(aborted.sort()).toEqual(["one", "two"]);
    expect(coordinator.getTeam("alpha")?.aborted).toBe(true);
  });

  test("cross-team delegation targets another team", async () => {
    const coordinator = createSwarmCoordinator({ localZoneId: zoneId("local") });
    coordinator.registerTeam({
      teamId: "alpha",
      leadAgentId: agentId("lead-a"),
      zoneId: zoneId("local"),
    });
    coordinator.registerTeam({
      teamId: "beta",
      leadAgentId: agentId("lead-b"),
      zoneId: zoneId("local"),
    });
    coordinator.registerMember({
      teamId: "beta",
      agentId: agentId("beta-worker"),
      capabilities: ["review"],
    });

    await expect(
      coordinator.delegateTask({
        fromTeamId: "alpha",
        toTeamId: "beta",
        task: task("review-1", ["review"]),
        strategy: "capability",
      }),
    ).resolves.toEqual({ ok: true, value: agentId("beta-worker") });
    expect(coordinator.getAssignments("beta")[0]).toMatchObject({
      delegatedFromTeamId: "alpha",
      taskId: "review-1",
      agentId: agentId("beta-worker"),
    });
  });

  test("missing federation falls back to local-only operation", async () => {
    const coordinator = createSwarmCoordinator({ localZoneId: zoneId("local") });
    coordinator.registerTeam({
      teamId: "local-team",
      leadAgentId: agentId("local-lead"),
      zoneId: zoneId("local"),
    });
    coordinator.registerTeam({
      teamId: "remote-team",
      leadAgentId: agentId("remote-lead"),
      zoneId: zoneId("remote"),
    });
    coordinator.registerMember({
      teamId: "local-team",
      agentId: agentId("local-worker"),
      capabilities: ["code"],
    });
    coordinator.registerMember({
      teamId: "remote-team",
      agentId: agentId("remote-worker"),
      capabilities: ["code"],
      zoneId: zoneId("remote"),
    });

    await expect(
      coordinator.distributeTask("remote-team", task("remote"), { strategy: "capability" }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Federation is not configured for remote team "remote-team"',
    });
    await expect(
      coordinator.distributeTask("local-team", task("local"), { strategy: "capability" }),
    ).resolves.toEqual({ ok: true, value: agentId("local-worker") });
  });
});
