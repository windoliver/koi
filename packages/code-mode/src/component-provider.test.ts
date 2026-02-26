import { describe, expect, test } from "bun:test";
import type { Tool } from "@koi/core";
import { toolToken } from "@koi/core";
import { createCodeModeProvider } from "./component-provider.js";
import { DEFAULT_PREFIX } from "./constants.js";
import { createMockAgent, createMockBackend } from "./test-helpers.js";

describe("createCodeModeProvider", () => {
  test("attaches 3 tools when FILESYSTEM is present", async () => {
    const backend = createMockBackend();
    const agent = createMockAgent(backend);
    const provider = createCodeModeProvider();

    const components = await provider.attach(agent);
    expect(components.size).toBe(3);

    const createTool = components.get(toolToken(`${DEFAULT_PREFIX}_create`) as string) as
      | Tool
      | undefined;
    expect(createTool).toBeDefined();
    expect(createTool?.descriptor.name).toBe("code_plan_create");

    const applyTool = components.get(toolToken(`${DEFAULT_PREFIX}_apply`) as string) as
      | Tool
      | undefined;
    expect(applyTool).toBeDefined();

    const statusTool = components.get(toolToken(`${DEFAULT_PREFIX}_status`) as string) as
      | Tool
      | undefined;
    expect(statusTool).toBeDefined();
  });

  test("returns empty map when FILESYSTEM is missing", async () => {
    const agent = createMockAgent();
    const provider = createCodeModeProvider();

    const components = await provider.attach(agent);
    expect(components.size).toBe(0);
  });

  test("uses custom prefix", async () => {
    const backend = createMockBackend();
    const agent = createMockAgent(backend);
    const provider = createCodeModeProvider({ prefix: "my_plan" });

    const components = await provider.attach(agent);
    const createTool = components.get(toolToken("my_plan_create") as string) as Tool | undefined;
    expect(createTool).toBeDefined();
    expect(createTool?.descriptor.name).toBe("my_plan_create");
  });

  test("uses custom trust tier", async () => {
    const backend = createMockBackend();
    const agent = createMockAgent(backend);
    const provider = createCodeModeProvider({ trustTier: "sandbox" });

    const components = await provider.attach(agent);
    const tool = components.get(toolToken(`${DEFAULT_PREFIX}_create`) as string) as
      | Tool
      | undefined;
    expect(tool?.trustTier).toBe("sandbox");
  });

  test("provider name is code-mode", () => {
    const provider = createCodeModeProvider();
    expect(provider.name).toBe("code-mode");
  });
});
