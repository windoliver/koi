import { describe, expect, it } from "bun:test";
import type { AgentManifest } from "@koi/core/assembly";
import type { AttachResult, Tool } from "@koi/core/ecs";
import { isAttachResult } from "@koi/core/ecs";
import { createMockAgent } from "@koi/test-utils";
import { createTaskSpawnProvider } from "./provider.js";
import type { TaskSpawnConfig, TaskSpawnResult } from "./types.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

const MOCK_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "0.0.1",
  model: { name: "test-model" },
};

function createConfig(): TaskSpawnConfig {
  return {
    agents: new Map([
      [
        "test",
        {
          name: "test-agent",
          description: "A test agent",
          manifest: MOCK_MANIFEST,
        },
      ],
    ]),
    spawn: async (): Promise<TaskSpawnResult> => ({
      ok: true,
      output: "done",
    }),
    defaultAgent: "test",
  };
}

describe("createTaskSpawnProvider", () => {
  it("has name 'task-spawn'", () => {
    const provider = createTaskSpawnProvider(createConfig());
    expect(provider.name).toBe("task-spawn");
  });

  it("attaches tool:task component", async () => {
    const provider = createTaskSpawnProvider(createConfig());
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));

    expect(components.has("tool:task")).toBe(true);
    expect(components.size).toBe(1);
  });

  it("attached tool has correct descriptor name", async () => {
    const provider = createTaskSpawnProvider(createConfig());
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));
    const tool = components.get("tool:task") as Tool;

    expect(tool.descriptor.name).toBe("task");
    expect(tool.descriptor.description).toBeDefined();
    expect(tool.descriptor.inputSchema).toBeDefined();
  });

  it("attached tool is callable", async () => {
    const provider = createTaskSpawnProvider(createConfig());
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));
    const tool = components.get("tool:task") as Tool;

    const result = await tool.execute({ description: "test task" });
    expect(result).toBe("done");
  });

  it("caches components across multiple attach() calls", async () => {
    const provider = createTaskSpawnProvider(createConfig());
    const agent = createMockAgent();

    const first = extractMap(await provider.attach(agent));
    const second = extractMap(await provider.attach(agent));

    expect(first).toBe(second);
  });
});
