import { describe, expect, it } from "bun:test";
import type { AgentManifest } from "@koi/core/assembly";
import type { TaskableAgent, TaskSpawnResult } from "./types.js";
import {
  createMapAgentResolver,
  createTaskToolDescriptor,
  isTaskSpawnFailure,
  isTaskSpawnSuccess,
  TASK_TOOL_DESCRIPTOR,
} from "./types.js";

const MOCK_MANIFEST: AgentManifest = {
  name: "test",
  version: "0.0.1",
  model: { name: "test-model" },
};

describe("isTaskSpawnSuccess", () => {
  it("returns true for ok result", () => {
    const result: TaskSpawnResult = { ok: true, output: "done" };
    expect(isTaskSpawnSuccess(result)).toBe(true);
  });

  it("returns false for error result", () => {
    const result: TaskSpawnResult = { ok: false, error: "failed" };
    expect(isTaskSpawnSuccess(result)).toBe(false);
  });
});

describe("isTaskSpawnFailure", () => {
  it("returns true for error result", () => {
    const result: TaskSpawnResult = { ok: false, error: "failed" };
    expect(isTaskSpawnFailure(result)).toBe(true);
  });

  it("returns false for ok result", () => {
    const result: TaskSpawnResult = { ok: true, output: "done" };
    expect(isTaskSpawnFailure(result)).toBe(false);
  });
});

describe("TASK_TOOL_DESCRIPTOR", () => {
  it("has name 'task'", () => {
    expect(TASK_TOOL_DESCRIPTOR.name).toBe("task");
  });

  it("requires description in input schema", () => {
    const schema = TASK_TOOL_DESCRIPTOR.inputSchema;
    expect(schema.required).toEqual(["description"]);
  });

  it("defines description and agent_type properties", () => {
    const props = TASK_TOOL_DESCRIPTOR.inputSchema.properties as Record<string, unknown>;
    expect(props.description).toBeDefined();
    expect(props.agent_type).toBeDefined();
  });
});

describe("createMapAgentResolver", () => {
  it("resolves agent by key from map (returns Result ok)", () => {
    const agent: TaskableAgent = {
      name: "test",
      description: "Test",
      manifest: MOCK_MANIFEST,
    };
    const resolver = createMapAgentResolver(new Map([["test", agent]]));
    const result = resolver.resolve("test");
    expect(result).toEqual({ ok: true, value: agent });
  });

  it("returns NOT_FOUND error for unknown key", async () => {
    const resolver = createMapAgentResolver(new Map());
    const result = await resolver.resolve("unknown");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("unknown");
    }
  });

  it("lists all agents as summaries", () => {
    const agents = new Map<string, TaskableAgent>([
      [
        "a",
        {
          name: "Agent A",
          description: "Does A",
          manifest: MOCK_MANIFEST,
        },
      ],
      [
        "b",
        {
          name: "Agent B",
          description: "Does B",
          manifest: MOCK_MANIFEST,
        },
      ],
    ]);
    const resolver = createMapAgentResolver(agents);
    const summaries = resolver.list();
    expect(summaries).toHaveLength(2);
    expect(summaries).toEqual([
      { key: "a", name: "Agent A", description: "Does A" },
      { key: "b", name: "Agent B", description: "Does B" },
    ]);
  });
});

describe("createTaskToolDescriptor", () => {
  it("creates descriptor with enum from summaries", () => {
    const summaries = [
      { key: "r", name: "Researcher", description: "Researches" },
      { key: "c", name: "Coder", description: "Codes" },
    ];
    const desc = createTaskToolDescriptor(summaries);
    expect(desc.name).toBe("task");
    const props = desc.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.agent_type?.enum).toEqual(["r", "c"]);
  });

  it("omits enum when summaries are empty", () => {
    const desc = createTaskToolDescriptor([]);
    const props = desc.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.agent_type?.enum).toBeUndefined();
  });

  it("builds description from summaries", () => {
    const summaries = [{ key: "r", name: "Researcher", description: "Researches topics" }];
    const desc = createTaskToolDescriptor(summaries);
    const props = desc.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.agent_type?.description).toContain("r: Researches topics");
  });
});
