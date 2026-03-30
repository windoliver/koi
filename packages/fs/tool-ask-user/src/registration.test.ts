import { describe, expect, test } from "bun:test";
import type { Agent, AgentId, Tool } from "@koi/core";
import { createAskUserRegistration } from "./registration.js";
import type { AskUserConfig } from "./types.js";

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

function stubConfig(): AskUserConfig {
  return {
    handler: async () => ({
      answered: true as const,
      selections: ["option-1"],
      freeText: undefined,
    }),
  } as unknown as AskUserConfig;
}

// ---------------------------------------------------------------------------
// createAskUserRegistration
// ---------------------------------------------------------------------------

describe("createAskUserRegistration", () => {
  test("returns a ToolRegistration with correct name", () => {
    const reg = createAskUserRegistration(stubConfig());
    expect(reg.name).toBe("ask-user");
  });

  test("provides one tool factory", () => {
    const reg = createAskUserRegistration(stubConfig());
    expect(reg.tools).toHaveLength(1);
    expect(reg.tools[0]?.name).toBe("ask_user");
  });

  test("tool factory produces a valid Tool object", async () => {
    const reg = createAskUserRegistration(stubConfig());
    const agent = stubAgent();
    const factory = reg.tools[0];
    if (factory === undefined) return;

    const tool = (await factory.create(agent)) as Tool;
    expect(tool.descriptor).toBeDefined();
    expect(tool.descriptor.name).toBe("ask_user");
    expect(typeof tool.execute).toBe("function");
  });

  test("has no availability check (ask_user is always available)", () => {
    const reg = createAskUserRegistration(stubConfig());
    expect(reg.checkAvailability).toBeUndefined();
  });
});
