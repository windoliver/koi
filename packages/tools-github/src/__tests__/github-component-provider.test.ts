import { describe, expect, test } from "bun:test";
import type { Tool } from "@koi/core";
import { createGithubProvider } from "../github-component-provider.js";
import { createMockAgent, createMockGhExecutor } from "../test-helpers.js";

describe("createGithubProvider", () => {
  test("attaches all 5 tools by default", async () => {
    const executor = createMockGhExecutor([]);
    const provider = createGithubProvider({ executor });
    const agent = createMockAgent();
    const components = await provider.attach(agent);

    expect(components.size).toBe(5);
    const keys = [...components.keys()];
    expect(keys).toContain("tool:github_pr_create");
    expect(keys).toContain("tool:github_pr_status");
    expect(keys).toContain("tool:github_pr_review");
    expect(keys).toContain("tool:github_pr_merge");
    expect(keys).toContain("tool:github_ci_wait");
  });

  test("uses custom prefix", async () => {
    const executor = createMockGhExecutor([]);
    const provider = createGithubProvider({ executor, prefix: "gh" });
    const agent = createMockAgent();
    const components = await provider.attach(agent);

    const keys = [...components.keys()];
    expect(keys).toContain("tool:gh_pr_create");
    expect(keys).toContain("tool:gh_pr_status");
  });

  test("assigns promoted trust tier to write operations", async () => {
    const executor = createMockGhExecutor([]);
    const provider = createGithubProvider({ executor });
    const agent = createMockAgent();
    const components = await provider.attach(agent);

    const prCreate = components.get("tool:github_pr_create") as Tool;
    const prMerge = components.get("tool:github_pr_merge") as Tool;
    const prReview = components.get("tool:github_pr_review") as Tool;
    expect(prCreate.trustTier).toBe("promoted");
    expect(prMerge.trustTier).toBe("promoted");
    expect(prReview.trustTier).toBe("promoted");
  });

  test("assigns configured trust tier to read operations", async () => {
    const executor = createMockGhExecutor([]);
    const provider = createGithubProvider({ executor, trustTier: "sandbox" });
    const agent = createMockAgent();
    const components = await provider.attach(agent);

    const prStatus = components.get("tool:github_pr_status") as Tool;
    const ciWait = components.get("tool:github_ci_wait") as Tool;
    expect(prStatus.trustTier).toBe("sandbox");
    expect(ciWait.trustTier).toBe("sandbox");
  });

  test("defaults read trust tier to verified", async () => {
    const executor = createMockGhExecutor([]);
    const provider = createGithubProvider({ executor });
    const agent = createMockAgent();
    const components = await provider.attach(agent);

    const prStatus = components.get("tool:github_pr_status") as Tool;
    expect(prStatus.trustTier).toBe("verified");
  });

  test("limits operations when specified", async () => {
    const executor = createMockGhExecutor([]);
    const provider = createGithubProvider({
      executor,
      operations: ["pr_create", "pr_status"],
    });
    const agent = createMockAgent();
    const components = await provider.attach(agent);

    expect(components.size).toBe(2);
    const keys = [...components.keys()];
    expect(keys).toContain("tool:github_pr_create");
    expect(keys).toContain("tool:github_pr_status");
    expect(keys).not.toContain("tool:github_pr_merge");
  });

  test("provider has correct name", () => {
    const executor = createMockGhExecutor([]);
    const provider = createGithubProvider({ executor });
    expect(provider.name).toBe("github:github");
  });

  test("provider name reflects custom prefix", () => {
    const executor = createMockGhExecutor([]);
    const provider = createGithubProvider({ executor, prefix: "gh" });
    expect(provider.name).toBe("github:gh");
  });

  test("each tool has a valid descriptor", async () => {
    const executor = createMockGhExecutor([]);
    const provider = createGithubProvider({ executor });
    const agent = createMockAgent();
    const components = await provider.attach(agent);

    for (const [_key, value] of components) {
      const tool = value as Tool;
      expect(tool.descriptor.name).toBeTruthy();
      expect(tool.descriptor.description).toBeTruthy();
      expect(tool.descriptor.inputSchema).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });
});
