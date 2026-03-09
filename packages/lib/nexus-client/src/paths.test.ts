import { describe, expect, test } from "bun:test";
import { agentGroupId, agentId, brickId, nexusPath } from "@koi/core";
import {
  agentBrickPath,
  agentBricksGlob,
  agentDeadLetterGlob,
  agentDeadLetterPath,
  agentEventGlob,
  agentEventMetaPath,
  agentEventPath,
  agentMemoryGlob,
  agentMemoryPath,
  agentPendingFramePath,
  agentPendingFramesGlob,
  agentSessionPath,
  agentSessionsGlob,
  agentSnapshotGlob,
  agentSnapshotPath,
  agentSubscriptionPath,
  agentWorkspaceGlob,
  agentWorkspacePath,
  gatewayNodePath,
  gatewayNodesGlob,
  gatewaySessionPath,
  gatewaySessionsGlob,
  gatewaySurfacePath,
  gatewaySurfacesGlob,
  globalBrickPath,
  groupScratchGlob,
  groupScratchPath,
  SEGMENTS,
} from "./paths.js";

const AGENT = agentId("agent-1");
const BRICK = brickId("brick-42");
const GROUP = agentGroupId("group-x");

describe("Nexus namespace paths", () => {
  describe("forge (brick artifacts)", () => {
    test("agentBrickPath", () => {
      expect(agentBrickPath(AGENT, BRICK)).toBe(nexusPath("agents/agent-1/bricks/brick-42.json"));
    });

    test("agentBricksGlob", () => {
      expect(agentBricksGlob(AGENT)).toBe(nexusPath("agents/agent-1/bricks/*.json"));
    });

    test("globalBrickPath", () => {
      expect(globalBrickPath(BRICK)).toBe(nexusPath("global/bricks/brick-42.json"));
    });
  });

  describe("events", () => {
    test("agentEventMetaPath", () => {
      expect(agentEventMetaPath(AGENT, "stream-a")).toBe(
        nexusPath("agents/agent-1/events/streams/stream-a/meta.json"),
      );
    });

    test("agentEventPath", () => {
      expect(agentEventPath(AGENT, "stream-a", "0000000001")).toBe(
        nexusPath("agents/agent-1/events/streams/stream-a/events/0000000001.json"),
      );
    });

    test("agentEventGlob", () => {
      expect(agentEventGlob(AGENT, "stream-a")).toBe(
        nexusPath("agents/agent-1/events/streams/stream-a/events/*.json"),
      );
    });
  });

  describe("session", () => {
    test("agentSessionPath", () => {
      expect(agentSessionPath(AGENT, "sess-1")).toBe(
        nexusPath("agents/agent-1/session/records/sess-1.json"),
      );
    });

    test("agentSessionsGlob", () => {
      expect(agentSessionsGlob(AGENT)).toBe(nexusPath("agents/agent-1/session/records/*.json"));
    });

    test("agentPendingFramePath", () => {
      expect(agentPendingFramePath(AGENT, "sess-1", "frame-1")).toBe(
        nexusPath("agents/agent-1/session/pending/sess-1/frame-1.json"),
      );
    });

    test("agentPendingFramesGlob", () => {
      expect(agentPendingFramesGlob(AGENT, "sess-1")).toBe(
        nexusPath("agents/agent-1/session/pending/sess-1/*.json"),
      );
    });
  });

  describe("memory", () => {
    test("agentMemoryPath", () => {
      expect(agentMemoryPath(AGENT, "user-prefs")).toBe(
        nexusPath("agents/agent-1/memory/entities/user-prefs.json"),
      );
    });

    test("agentMemoryGlob", () => {
      expect(agentMemoryGlob(AGENT)).toBe(nexusPath("agents/agent-1/memory/entities/*.json"));
    });
  });

  describe("snapshots", () => {
    test("agentSnapshotPath", () => {
      expect(agentSnapshotPath(AGENT, "chain-1", "node-a")).toBe(
        nexusPath("agents/agent-1/snapshots/chain-1/node-a.json"),
      );
    });

    test("agentSnapshotGlob", () => {
      expect(agentSnapshotGlob(AGENT, "chain-1")).toBe(
        nexusPath("agents/agent-1/snapshots/chain-1/*.json"),
      );
    });
  });

  describe("group scratchpad", () => {
    test("groupScratchPath", () => {
      expect(groupScratchPath(GROUP, "config.yaml")).toBe(
        nexusPath("groups/group-x/scratch/config.yaml"),
      );
    });

    test("groupScratchGlob", () => {
      expect(groupScratchGlob(GROUP)).toBe(nexusPath("groups/group-x/scratch/**"));
    });
  });

  describe("subscriptions and dead letters", () => {
    test("agentSubscriptionPath", () => {
      expect(agentSubscriptionPath(AGENT, "sub-1")).toBe(
        nexusPath("agents/agent-1/events/subscriptions/sub-1.json"),
      );
    });

    test("agentDeadLetterPath", () => {
      expect(agentDeadLetterPath(AGENT, "dl-1")).toBe(
        nexusPath("agents/agent-1/events/dead-letters/dl-1.json"),
      );
    });

    test("agentDeadLetterGlob", () => {
      expect(agentDeadLetterGlob(AGENT)).toBe(
        nexusPath("agents/agent-1/events/dead-letters/*.json"),
      );
    });
  });

  describe("workspace", () => {
    test("agentWorkspacePath", () => {
      expect(agentWorkspacePath(AGENT, "src/main.ts")).toBe(
        nexusPath("agents/agent-1/workspace/src/main.ts"),
      );
    });

    test("agentWorkspaceGlob", () => {
      expect(agentWorkspaceGlob(AGENT)).toBe(nexusPath("agents/agent-1/workspace/**"));
    });
  });

  describe("SEGMENTS", () => {
    test("exports all domain segments", () => {
      expect(SEGMENTS.bricks).toBe("bricks");
      expect(SEGMENTS.events).toBe("events");
      expect(SEGMENTS.session).toBe("session");
      expect(SEGMENTS.memory).toBe("memory/entities");
      expect(SEGMENTS.snapshots).toBe("snapshots");
      expect(SEGMENTS.workspace).toBe("workspace");
      expect(SEGMENTS.mailbox).toBe("mailbox");
    });

    test("segments have no leading or trailing slashes", () => {
      for (const segment of Object.values(SEGMENTS)) {
        expect(segment.startsWith("/")).toBe(false);
        expect(segment.endsWith("/")).toBe(false);
      }
    });
  });

  describe("gateway (global namespace)", () => {
    test("gatewaySessionPath", () => {
      expect(gatewaySessionPath("sess-1")).toBe(nexusPath("global/gateway/sessions/sess-1.json"));
    });

    test("gatewaySessionsGlob", () => {
      expect(gatewaySessionsGlob()).toBe(nexusPath("global/gateway/sessions/*.json"));
    });

    test("gatewayNodePath", () => {
      expect(gatewayNodePath("node-a")).toBe(nexusPath("global/gateway/nodes/node-a.json"));
    });

    test("gatewayNodesGlob", () => {
      expect(gatewayNodesGlob()).toBe(nexusPath("global/gateway/nodes/*.json"));
    });

    test("gatewaySurfacePath", () => {
      expect(gatewaySurfacePath("surface-x")).toBe(
        nexusPath("global/gateway/surfaces/surface-x.json"),
      );
    });

    test("gatewaySurfacesGlob", () => {
      expect(gatewaySurfacesGlob()).toBe(nexusPath("global/gateway/surfaces/*.json"));
    });
  });
});
