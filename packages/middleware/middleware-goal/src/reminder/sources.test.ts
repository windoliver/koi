/**
 * Per-variant source resolution tests for resolveAllSources.
 */

import { describe, expect, test } from "bun:test";
import type { TurnContext } from "@koi/core/middleware";
import { createMockTurnContext } from "@koi/test-utils";
import { resolveAllSources } from "./sources.js";
import type { ReminderSource } from "./types.js";

const mockCtx: TurnContext = createMockTurnContext();

describe("resolveAllSources", () => {
  test("resolves manifest source into <goals> block", async () => {
    const sources: readonly ReminderSource[] = [
      { kind: "manifest", objectives: ["search the web", "write report"] },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toContain("<goals>");
    expect(result).toContain("- search the web");
    expect(result).toContain("- write report");
    expect(result).toContain("</goals>");
    expect(result).toContain("<reminder>");
    expect(result).toContain("</reminder>");
  });

  test("resolves static text source into <context> block", async () => {
    const sources: readonly ReminderSource[] = [
      { kind: "static", text: "Always respond in JSON format" },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toContain("<context>");
    expect(result).toContain("Always respond in JSON format");
    expect(result).toContain("</context>");
  });

  test("resolves sync dynamic fetch into <context> block", async () => {
    const sources: readonly ReminderSource[] = [
      { kind: "dynamic", fetch: () => "live constraint data" },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toContain("<context>");
    expect(result).toContain("live constraint data");
    expect(result).toContain("</context>");
  });

  test("resolves async dynamic fetch into <context> block", async () => {
    const sources: readonly ReminderSource[] = [
      {
        kind: "dynamic",
        fetch: () => Promise.resolve("async constraint data"),
      },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toContain("<context>");
    expect(result).toContain("async constraint data");
    expect(result).toContain("</context>");
  });

  test("dynamic fetch receives TurnContext", async () => {
    let receivedCtx: TurnContext | undefined;
    const sources: readonly ReminderSource[] = [
      {
        kind: "dynamic",
        fetch: (ctx) => {
          receivedCtx = ctx;
          return "context-aware data";
        },
      },
    ];
    const turnCtx = createMockTurnContext({ turnIndex: 7 });
    await resolveAllSources(sources, turnCtx);
    expect(receivedCtx).toBeDefined();
    expect(receivedCtx?.turnIndex).toBe(7);
  });

  test("resolves sync tasks provider into <tasks> block", async () => {
    const sources: readonly ReminderSource[] = [
      { kind: "tasks", provider: () => ["task 1", "task 2"] },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toContain("<tasks>");
    expect(result).toContain("- task 1");
    expect(result).toContain("- task 2");
    expect(result).toContain("</tasks>");
  });

  test("resolves async tasks provider into <tasks> block", async () => {
    const sources: readonly ReminderSource[] = [
      {
        kind: "tasks",
        provider: () => Promise.resolve(["async task A", "async task B"]),
      },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toContain("<tasks>");
    expect(result).toContain("- async task A");
    expect(result).toContain("- async task B");
    expect(result).toContain("</tasks>");
  });

  test("tasks provider receives TurnContext", async () => {
    let receivedCtx: TurnContext | undefined;
    const sources: readonly ReminderSource[] = [
      {
        kind: "tasks",
        provider: (ctx) => {
          receivedCtx = ctx;
          return ["task from context"];
        },
      },
    ];
    const turnCtx = createMockTurnContext({ turnIndex: 3 });
    await resolveAllSources(sources, turnCtx);
    expect(receivedCtx).toBeDefined();
    expect(receivedCtx?.turnIndex).toBe(3);
  });

  test("dynamic fetch can derive goal from conversation messages", async () => {
    const sources: readonly ReminderSource[] = [
      {
        kind: "dynamic",
        fetch: (ctx) => {
          const firstMsg = ctx.messages[0];
          const textBlock = firstMsg?.content.find((b) => b.kind === "text");
          const text = textBlock?.kind === "text" ? textBlock.text : "unknown";
          return `Current goal: ${text}`;
        },
      },
    ];
    const turnCtx = createMockTurnContext({
      messages: [
        {
          senderId: "user",
          timestamp: Date.now(),
          content: [{ kind: "text", text: "Refactor auth module" }],
        },
      ],
    });
    const result = await resolveAllSources(sources, turnCtx);
    expect(result).toContain("Current goal: Refactor auth module");
  });

  test("fail-safe: dynamic fetch that throws returns placeholder", async () => {
    const sources: readonly ReminderSource[] = [
      {
        kind: "dynamic",
        fetch: () => {
          throw new Error("network error");
        },
      },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toContain("[dynamic source unavailable]");
    expect(result).toContain("<reminder>");
  });

  test("fail-safe: tasks provider that throws returns placeholder", async () => {
    const sources: readonly ReminderSource[] = [
      {
        kind: "tasks",
        provider: () => {
          throw new Error("database down");
        },
      },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toContain("[task source unavailable]");
    expect(result).toContain("<reminder>");
  });

  test("fail-safe: async rejection returns placeholder", async () => {
    const sources: readonly ReminderSource[] = [
      {
        kind: "dynamic",
        fetch: () => Promise.reject(new Error("timeout")),
      },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toContain("[dynamic source unavailable]");
  });

  test("returns empty string when tasks provider returns empty array", async () => {
    const sources: readonly ReminderSource[] = [{ kind: "tasks", provider: () => [] }];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toBe("");
  });

  test("returns empty string when all sources resolve to empty content", async () => {
    const sources: readonly ReminderSource[] = [
      { kind: "tasks", provider: () => [] },
      { kind: "manifest", objectives: [] },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    expect(result).toBe("");
  });

  test("combines multiple sources in order", async () => {
    const sources: readonly ReminderSource[] = [
      { kind: "manifest", objectives: ["goal 1"] },
      { kind: "static", text: "constraint text" },
      { kind: "tasks", provider: () => ["active task"] },
    ];
    const result = await resolveAllSources(sources, mockCtx);
    const goalsIdx = result.indexOf("<goals>");
    const contextIdx = result.indexOf("<context>");
    const tasksIdx = result.indexOf("<tasks>");
    expect(goalsIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(tasksIdx);
  });
});
