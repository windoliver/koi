import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, Tool } from "@koi/core";
import { COMPONENT_PRIORITY } from "@koi/core";
import { createManagedTaskBoard, createMemoryTaskBoardStore } from "@koi/tasks";
import { createTaskToolsProvider } from "./provider.js";

function agentId(id: string): AgentId {
  return id as AgentId;
}

describe("createTaskToolsProvider", () => {
  test("returns ComponentProvider with name 'task-tools'", async () => {
    const store = createMemoryTaskBoardStore();
    const resultsDir = await mkdtemp(join(tmpdir(), "koi-provider-test-"));
    const board = await createManagedTaskBoard({ store, resultsDir });

    const provider = createTaskToolsProvider({
      board,
      agentId: agentId("agent-1"),
    });

    expect(provider.name).toBe("task-tools");
  });

  test("attach returns all 7 tools under toolToken keys", async () => {
    const store = createMemoryTaskBoardStore();
    const resultsDir = await mkdtemp(join(tmpdir(), "koi-provider-test-"));
    const board = await createManagedTaskBoard({ store, resultsDir });

    const provider = createTaskToolsProvider({
      board,
      agentId: agentId("agent-1"),
    });

    const result = await provider.attach({} as never);

    // AttachResult has a components map
    const resultObj = result as unknown as Record<string, unknown>;
    const components =
      "components" in resultObj
        ? (resultObj.components as ReadonlyMap<string, unknown>)
        : (result as ReadonlyMap<string, unknown>);

    // Expect 7 tools: task_create, task_get, task_update, task_list, task_stop, task_output, task_delegate
    expect(components.size).toBe(7);

    const expectedKeys = [
      "tool:task_create",
      "tool:task_get",
      "tool:task_update",
      "tool:task_list",
      "tool:task_stop",
      "tool:task_output",
      "tool:task_delegate",
    ];
    for (const key of expectedKeys) {
      expect(components.has(key)).toBe(true);
      const tool = components.get(key) as Tool;
      expect(tool.descriptor).toBeDefined();
      expect(tool.execute).toBeDefined();
    }
  });

  test("priority defaults to COMPONENT_PRIORITY.BUNDLED", async () => {
    const store = createMemoryTaskBoardStore();
    const resultsDir = await mkdtemp(join(tmpdir(), "koi-provider-test-"));
    const board = await createManagedTaskBoard({ store, resultsDir });

    const provider = createTaskToolsProvider({
      board,
      agentId: agentId("agent-1"),
    });

    expect(provider.priority).toBe(COMPONENT_PRIORITY.BUNDLED);
  });

  test("custom priority is respected", async () => {
    const store = createMemoryTaskBoardStore();
    const resultsDir = await mkdtemp(join(tmpdir(), "koi-provider-test-"));
    const board = await createManagedTaskBoard({ store, resultsDir });

    const provider = createTaskToolsProvider({
      board,
      agentId: agentId("agent-1"),
      priority: COMPONENT_PRIORITY.AGENT_FORGED,
    });

    expect(provider.priority).toBe(COMPONENT_PRIORITY.AGENT_FORGED);
  });
});
