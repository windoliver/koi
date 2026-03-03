/**
 * Integration test: full hydration pipeline.
 *
 * YAML config → validateContextConfig → createContextHydrator → wrapModelCall → verify system message.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryComponent, SkillComponent, Tool } from "@koi/core";
import { MEMORY, skillToken, toolToken } from "@koi/core";
import { createMockAgent, createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { validateContextConfig } from "../src/config.js";
import { createContextHydrator } from "../src/hydrator.js";

const tempFiles: string[] = [];

function createTempFile(content: string): string {
  const path = join(
    tmpdir(),
    `koi-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  writeFileSync(path, content);
  tempFiles.push(path);
  return path;
}

afterEach(() => {
  for (const f of tempFiles) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  tempFiles.length = 0;
});

describe("Hydration pipeline — end-to-end", () => {
  test("full pipeline: validate → hydrate → wrap model call", async () => {
    const knowledgePath = createTempFile("# Knowledge Base\n\nImportant facts here.");

    // Simulate what comes from koi.yaml parsing
    const rawConfig = {
      maxTokens: 8000,
      sources: [
        {
          kind: "text",
          label: "System Policy",
          text: "You are a research assistant. Always cite sources.",
          required: true,
          priority: 0,
        },
        {
          kind: "file",
          label: "Knowledge Base",
          path: knowledgePath,
          priority: 10,
        },
        {
          kind: "tool_schema",
          label: "Available Tools",
          priority: 50,
        },
      ],
    };

    // Step 1: Validate
    const validation = validateContextConfig(rawConfig);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    // Step 2: Create agent with tools
    const searchTool: Tool = {
      descriptor: {
        name: "search",
        description: "Search the web",
        inputSchema: { type: "object" },
      },
      trustTier: "sandbox",
      async execute() {
        return {};
      },
    };
    const components = new Map<string, unknown>([[toolToken("search") as string, searchTool]]);
    const agent = createMockAgent({ components });

    // Step 3: Create hydrator
    const mw = createContextHydrator({ config: validation.value, agent });

    // Step 4: Hydrate on session start
    await mw.onSessionStart?.({ agentId: "test", sessionId: "s1", metadata: {} });

    // Step 5: Verify system message injection
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(
      ctx,
      {
        messages: [
          {
            content: [{ kind: "text", text: "What is quantum computing?" }],
            senderId: "user",
            timestamp: Date.now(),
          },
        ],
      },
      spy.handler,
    );

    expect(spy.calls).toHaveLength(1);
    const request = spy.calls[0];
    expect(request).toBeDefined();

    // System message should be first
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]?.senderId).toBe("system:context");
    // User message should be second
    expect(request.messages[1]?.senderId).toBe("user");

    // Verify content contains all resolved sources
    const systemText = (request.messages[0]?.content[0] as { text: string }).text;
    expect(systemText).toContain("You are a research assistant.");
    expect(systemText).toContain("Knowledge Base");
    expect(systemText).toContain("Important facts here.");
    expect(systemText).toContain("Available Tools");
    expect(systemText).toContain("search");
  });

  test("pipeline with mixed required and optional sources", async () => {
    const rawConfig = {
      sources: [
        { kind: "text", text: "Base context", required: true, priority: 0 },
        { kind: "file", path: "/nonexistent/optional.md", required: false, priority: 10 },
        { kind: "memory", query: "user prefs", required: false, priority: 20 },
      ],
    };

    const validation = validateContextConfig(rawConfig);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const agent = createMockAgent(); // No memory component

    const mw = createContextHydrator({ config: validation.value, agent });

    // Should not throw even though file and memory fail
    await mw.onSessionStart?.({ agentId: "test", sessionId: "s1", metadata: {} });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    // Only the text source should be present
    const systemText = (spy.calls[0]?.messages[0]?.content[0] as { text: string }).text;
    expect(systemText).toContain("Base context");
  });

  test("pipeline with memory and skill sources", async () => {
    const memory: MemoryComponent = {
      async recall() {
        return [{ content: "User prefers dark mode" }, { content: "User speaks English" }];
      },
      async store() {},
    };

    const skill: SkillComponent = {
      name: "research",
      description: "Research topics from the web",
      content: "",
      tags: ["web", "search"],
    };

    const components = new Map<string, unknown>([
      [MEMORY as string, memory],
      [skillToken("research") as string, skill],
    ]);
    const agent = createMockAgent({ components });

    const rawConfig = {
      sources: [
        { kind: "memory", query: "user preferences", label: "Preferences", priority: 0 },
        { kind: "skill", name: "research", label: "Research Skill", priority: 10 },
      ],
    };

    const validation = validateContextConfig(rawConfig);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const mw = createContextHydrator({ config: validation.value, agent });
    await mw.onSessionStart?.({ agentId: "test", sessionId: "s1", metadata: {} });

    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);

    const systemText = (spy.calls[0]?.messages[0]?.content[0] as { text: string }).text;
    expect(systemText).toContain("User prefers dark mode");
    expect(systemText).toContain("User speaks English");
    expect(systemText).toContain("Research topics from the web");
    expect(systemText).toContain("Tags: web, search");
  });
});
