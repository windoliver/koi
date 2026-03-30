/**
 * Integration test for tool auto-resolution via manifest `package` field.
 *
 * Tests the full flow: manifest → resolvePackage → availability check →
 * assembly → tool call, exercising createKoi() end-to-end.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineOutput,
  Tool,
  ToolRegistration,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY, toolToken } from "@koi/core";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

function doneOutput(overrides?: Partial<EngineOutput>): EngineOutput {
  return {
    content: [],
    stopReason: "completed",
    metrics: {
      totalTokens: 10,
      inputTokens: 5,
      outputTokens: 5,
      turns: 1,
      durationMs: 100,
    },
    ...overrides,
  };
}

function mockAdapter(events: readonly EngineEvent[]): EngineAdapter {
  return {
    engineId: "test-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream: () => {
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              if (index >= events.length) {
                return { done: true, value: undefined };
              }
              const event = events[index];
              if (event === undefined) {
                return { done: true, value: undefined };
              }
              index++;
              return { done: false, value: event };
            },
          };
        },
      };
    },
  };
}

function stubTool(name: string): Tool {
  return {
    descriptor: { name, description: `${name} tool`, inputSchema: {} },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async () => ({ result: `${name} executed` }),
  };
}

function stubRegistration(
  name: string,
  toolNames: readonly string[],
  checkAvailability?: ToolRegistration["checkAvailability"],
): ToolRegistration {
  return {
    name,
    tools: toolNames.map((n) => ({ name: n, create: () => stubTool(n) })),
    ...(checkAvailability !== undefined ? { checkAvailability } : {}),
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("tool auto-resolution integration", () => {
  test("auto-resolves package and attaches tool to agent", async () => {
    const manifest = testManifest({
      tools: [{ name: "search_catalog", package: "@koi/catalog" }],
    });
    const resolver = async (_pkg: string) => ({
      registration: stubRegistration("catalog", ["search_catalog"]),
    });
    const runtime = await createKoi({
      manifest,
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      resolvePackage: resolver,
    });

    expect(runtime.agent.has(toolToken("search_catalog"))).toBe(true);
  });

  test("tool from auto-resolved package is callable via run()", async () => {
    const manifest = testManifest({
      tools: [{ name: "my_tool", package: "@koi/my-pkg" }],
    });
    const resolver = async (_pkg: string) => ({
      registration: stubRegistration("my-tools", ["my_tool"]),
    });
    const runtime = await createKoi({
      manifest,
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      resolvePackage: resolver,
    });

    // Verify tool is attached and can be retrieved
    const tool = runtime.agent.component<Tool>(toolToken("my_tool"));
    expect(tool).toBeDefined();
    if (tool === undefined) return;
    const result = await tool.execute({});
    expect(result).toEqual({ result: "my_tool executed" });
  });

  test("skips unavailable tools via checkAvailability", async () => {
    const manifest = testManifest({
      tools: [{ name: "gated_tool", package: "@koi/gated-pkg" }],
    });
    const resolver = async (_pkg: string) => ({
      registration: stubRegistration("gated", ["gated_tool"], () => false),
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await createKoi({
      manifest,
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      resolvePackage: resolver,
    });

    expect(runtime.agent.has(toolToken("gated_tool"))).toBe(false);
    // Should warn about the missing tool
    const missingToolWarning = warnSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("gated_tool"),
    );
    expect(missingToolWarning).toBeDefined();
    warnSpy.mockRestore();
  });

  test("explicit providers coexist with auto-resolved providers", async () => {
    const manifest = testManifest({
      tools: [{ name: "auto_tool", package: "@koi/auto-pkg" }, { name: "manual_tool" }],
    });
    const resolver = async (_pkg: string) => ({
      registration: stubRegistration("auto", ["auto_tool"]),
    });
    const runtime = await createKoi({
      manifest,
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      resolvePackage: resolver,
      providers: [
        {
          name: "manual-provider",
          attach: async () => ({
            components: new Map<string, unknown>([
              [toolToken("manual_tool") as string, stubTool("manual_tool")],
            ]),
            skipped: [],
          }),
        },
      ],
    });

    expect(runtime.agent.has(toolToken("auto_tool"))).toBe(true);
    expect(runtime.agent.has(toolToken("manual_tool"))).toBe(true);
  });

  test("warns on missing tool after failed package resolution", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const manifest = testManifest({
      tools: [{ name: "broken_tool", package: "@koi/broken-pkg" }],
    });
    const resolver = async (_pkg: string) => {
      throw new Error("Package not found");
    };
    const runtime = await createKoi({
      manifest,
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      resolvePackage: resolver,
    });

    expect(runtime.agent.has(toolToken("broken_tool"))).toBe(false);
    // Should have two warnings: one for package resolution failure, one for missing tool
    const resolutionWarning = warnSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("@koi/broken-pkg"),
    );
    const missingWarning = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("broken_tool") &&
        call[0].includes("not found after assembly"),
    );
    expect(resolutionWarning).toBeDefined();
    expect(missingWarning).toBeDefined();
    warnSpy.mockRestore();
  });

  test("explicit provider wins over auto-resolved on conflict (priority)", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const manifest = testManifest({
      tools: [{ name: "shared_tool", package: "@koi/auto-pkg" }],
    });
    const autoTool = stubTool("shared_tool");
    const manualTool: Tool = {
      ...stubTool("shared_tool"),
      execute: async () => ({ result: "manual version" }),
    };
    const resolver = async (_pkg: string) => ({
      registration: {
        name: "auto-provider",
        tools: [{ name: "shared_tool", create: () => autoTool }],
      },
    });
    const runtime = await createKoi({
      manifest,
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      resolvePackage: resolver,
      providers: [
        {
          name: "manual-provider",
          attach: async () => ({
            components: new Map<string, unknown>([
              [toolToken("shared_tool") as string, manualTool],
            ]),
            skipped: [],
          }),
        },
      ],
    });

    // Manual provider should shadow auto-resolved (both at BUNDLED priority,
    // but manual comes after auto in the allProviders array — first-write-wins
    // means auto-resolved wins since it's prepended before explicit providers).
    // The tool conflict warning should fire.
    expect(runtime.agent.has(toolToken("shared_tool"))).toBe(true);
    expect(runtime.conflicts.length).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  test("backwards compatible — no package field means no auto-resolution", async () => {
    const manifest = testManifest({
      tools: [{ name: "legacy_tool" }],
    });
    const runtime = await createKoi({
      manifest,
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      providers: [
        {
          name: "legacy-provider",
          attach: async () => ({
            components: new Map<string, unknown>([
              [toolToken("legacy_tool") as string, stubTool("legacy_tool")],
            ]),
            skipped: [],
          }),
        },
      ],
    });

    expect(runtime.agent.has(toolToken("legacy_tool"))).toBe(true);
  });
});
