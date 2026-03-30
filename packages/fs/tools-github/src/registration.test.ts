import { describe, expect, test } from "bun:test";
import type { Agent, AgentId, Tool } from "@koi/core";
import type { GhExecutor } from "./gh-executor.js";
import { createGithubRegistration } from "./registration.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubAgent(): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: {
      id: "test-agent" as AgentId,
      name: "test",
      type: "copilot",
      depth: 0,
    },
    manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
    state: "created",
    component: (token) => components.get(token as string) as undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: () => new Map(),
    components: () => components,
  };
}

function stubExecutor(): GhExecutor {
  return {
    execute: async () => ({
      ok: true as const,
      stdout: "{}",
      stderr: "",
    }),
  } as unknown as GhExecutor;
}

// ---------------------------------------------------------------------------
// createGithubRegistration
// ---------------------------------------------------------------------------

describe("createGithubRegistration", () => {
  test("returns a ToolRegistration with correct name", () => {
    const reg = createGithubRegistration({ executor: stubExecutor() });
    expect(reg.name).toBe("github");
  });

  test("provides five tool factories", () => {
    const reg = createGithubRegistration({ executor: stubExecutor() });
    expect(reg.tools).toHaveLength(5);
    expect(reg.tools[0]?.name).toBe("github_pr_create");
    expect(reg.tools[1]?.name).toBe("github_pr_status");
    expect(reg.tools[2]?.name).toBe("github_pr_review");
    expect(reg.tools[3]?.name).toBe("github_pr_merge");
    expect(reg.tools[4]?.name).toBe("github_ci_wait");
  });

  test("tool factories produce valid Tool objects", async () => {
    const reg = createGithubRegistration({ executor: stubExecutor() });
    const agent = stubAgent();

    for (const factory of reg.tools) {
      const tool = (await factory.create(agent)) as Tool;
      expect(tool.descriptor).toBeDefined();
      expect(tool.descriptor.name).toBe(factory.name);
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("respects custom prefix", () => {
    const reg = createGithubRegistration({
      executor: stubExecutor(),
      prefix: "gh",
    });
    expect(reg.tools[0]?.name).toBe("gh_pr_create");
    expect(reg.tools[4]?.name).toBe("gh_ci_wait");
  });

  test("respects operations filter", () => {
    const reg = createGithubRegistration({
      executor: stubExecutor(),
      operations: ["pr_status", "ci_wait"],
    });
    expect(reg.tools).toHaveLength(2);
    expect(reg.tools[0]?.name).toBe("github_pr_status");
    expect(reg.tools[1]?.name).toBe("github_ci_wait");
  });
});
