import { describe, expect, test } from "bun:test";
import type { MemoryRecord, MemoryRecordId } from "@koi/core";
import { syncTeamMemories } from "./sync.js";
import type { TeamSyncConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMemory(
  id: string,
  type: "user" | "feedback" | "project" | "reference",
  content: string = "safe content",
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    name: `Memory ${id}`,
    description: `Description for ${id}`,
    type,
    content,
    filePath: `${id}.md`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncTeamMemories", () => {
  test("returns skipped when no remote endpoint", async () => {
    const config: TeamSyncConfig = {
      listMemories: async () => [],
      agentId: "agent-1",
    };
    const result = await syncTeamMemories(config);

    expect(result.skipped).toBe(true);
    expect(result.eligible).toBe(0);
    expect(result.blocked).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  test("returns skipped when remote endpoint is empty string", async () => {
    const config: TeamSyncConfig = {
      listMemories: async () => [],
      remoteEndpoint: "",
      agentId: "agent-1",
    };
    const result = await syncTeamMemories(config);

    expect(result.skipped).toBe(true);
  });

  test("filters and counts memories with endpoint configured", async () => {
    const memories = [
      createMemory("1", "feedback", "safe learning"),
      createMemory("2", "user", "private info"),
      createMemory("3", "project", "team context"),
    ];
    const config: TeamSyncConfig = {
      listMemories: async () => memories,
      remoteEndpoint: "https://nexus.example.com/sync",
      agentId: "agent-1",
      teamId: "team-alpha",
    };
    const result = await syncTeamMemories(config);

    expect(result.skipped).toBe(false);
    expect(result.eligible).toBe(2); // feedback + project
    expect(result.blocked).toBe(1); // user denied
    expect(result.blockedEntries).toHaveLength(1);
    expect(result.blockedEntries[0]?.reason).toBe("type_denied");
    // Transport not implemented — should have an error
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("transport not yet implemented");
  });

  test("returns no errors when all memories are blocked", async () => {
    const memories = [createMemory("1", "user", "private")];
    const config: TeamSyncConfig = {
      listMemories: async () => memories,
      remoteEndpoint: "https://nexus.example.com/sync",
      agentId: "agent-1",
    };
    const result = await syncTeamMemories(config);

    expect(result.eligible).toBe(0);
    expect(result.blocked).toBe(1);
    expect(result.errors).toHaveLength(0); // No transport error since nothing to push
  });

  test("respects custom allowedTypes", async () => {
    const memories = [
      createMemory("1", "feedback", "learning"),
      createMemory("2", "reference", "external link"),
    ];
    const config: TeamSyncConfig = {
      listMemories: async () => memories,
      remoteEndpoint: "https://nexus.example.com/sync",
      agentId: "agent-1",
      allowedTypes: ["feedback"], // Only feedback allowed
    };
    const result = await syncTeamMemories(config);

    expect(result.eligible).toBe(1);
    expect(result.blocked).toBe(1);
  });

  test("blocks memories with secrets even with allowed type", async () => {
    const memories = [createMemory("1", "feedback", "password=MySuperSecretPassword123")];
    const config: TeamSyncConfig = {
      listMemories: async () => memories,
      remoteEndpoint: "https://nexus.example.com/sync",
      agentId: "agent-1",
    };
    const result = await syncTeamMemories(config);

    expect(result.eligible).toBe(0);
    expect(result.blocked).toBe(1);
    expect(result.blockedEntries[0]?.reason).toBe("secret_detected");
  });
});
