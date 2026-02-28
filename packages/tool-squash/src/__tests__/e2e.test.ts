/**
 * Integration tests — tool → middleware flow with real stores.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { chainId, skillToken } from "@koi/core";
import type { MemoryComponent, SessionId, SkillComponent } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, TurnContext } from "@koi/core/middleware";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { createSquashProvider } from "../provider.js";
import { SQUASH_SKILL_NAME } from "../skill.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(text: string, opts?: { readonly pinned?: boolean }): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId: "user",
    timestamp: Date.now(),
    ...(opts?.pinned === true ? { pinned: true } : {}),
  };
}

function makeTurnContext(): TurnContext {
  return {
    session: {
      agentId: "agent-1",
      sessionId: "session-1" as SessionId,
      runId: "run-1" as TurnContext["session"]["runId"],
      metadata: {},
    },
    turnIndex: 0,
    turnId: "run-1:t0" as TurnContext["turnId"],
    messages: [],
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool-squash e2e", () => {
  // let justified: reset per test
  let messages: InboundMessage[];

  beforeEach(() => {
    messages = [];
  });

  test("full flow: tool → middleware replaces messages", async () => {
    const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();
    const sid = "session-e2e-1" as SessionId;
    messages = Array.from({ length: 8 }, (_, i) => makeMessage(`message ${String(i)}`));

    const { provider, middleware } = createSquashProvider(
      { archiver, sessionId: sid },
      () => messages,
    );

    // Attach provider to get the tool
    const components = await provider.attach({
      pid: { id: "agent-1" as never, name: "test", type: "copilot", depth: 0 },
      manifest: {} as never,
      state: "running",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    // Get tool from components
    const toolEntry =
      components instanceof Map
        ? components
        : (components as { readonly components: ReadonlyMap<string, unknown> }).components;
    const tool = toolEntry.get("tool:squash") as {
      readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
    };
    expect(tool).toBeDefined();

    // Execute squash
    const result = (await tool.execute({
      phase: "planning",
      summary: "Planning phase complete. Key decisions: use TypeScript, target Node 22.",
    })) as { readonly ok: boolean; readonly originalMessages: number };

    expect(result.ok).toBe(true);
    expect(result.originalMessages).toBe(4); // 8 - 4 preserveRecent

    // Now apply via middleware
    const originalRequest: ModelRequest = {
      messages: [makeMessage("this should be replaced")],
    };
    const next = mock(async (_req: ModelRequest) => ({
      content: "response",
      model: "test",
      metadata: {},
    }));

    await middleware.wrapModelCall?.(makeTurnContext(), originalRequest, next);

    // Verify middleware replaced the messages
    const passedRequest = next.mock.calls[0]?.[0] as ModelRequest;
    expect(passedRequest.messages).not.toBe(originalRequest.messages);
    // Should contain the summary message
    const summaryMsg = passedRequest.messages.find((m) => m.senderId === "system:squash");
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.content[0]).toMatchObject({ kind: "text" });
  });

  test("full flow with real snapshot store: archive retrievable", async () => {
    const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();
    const sid = "session-e2e-2" as SessionId;
    messages = Array.from({ length: 6 }, (_, i) => makeMessage(`msg ${String(i)}`));

    const { provider } = createSquashProvider({ archiver, sessionId: sid }, () => messages);

    const components = await provider.attach({
      pid: { id: "agent-1" as never, name: "test", type: "copilot", depth: 0 },
      manifest: {} as never,
      state: "running",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const toolEntry =
      components instanceof Map
        ? components
        : (components as { readonly components: ReadonlyMap<string, unknown> }).components;
    const tool = toolEntry.get("tool:squash") as {
      readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    await tool.execute({
      phase: "research",
      summary: "Research complete.",
    });

    // Verify archive is retrievable
    const archiveChainId = chainId(`squash:${sid}`);
    const headResult = await archiver.head(archiveChainId);
    expect(headResult.ok).toBe(true);
    if (headResult.ok && headResult.value !== undefined) {
      expect(headResult.value.data.length).toBe(2); // 6 - 4 preserveRecent
      expect(headResult.value.metadata).toMatchObject({ phase: "research" });
    }
  });

  test("full flow with facts: memory.store called", async () => {
    const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();
    const sid = "session-e2e-3" as SessionId;
    const storeMock = mock(() => Promise.resolve());
    const memory: MemoryComponent = {
      recall: mock(() => Promise.resolve([])),
      store: storeMock,
    };
    messages = Array.from({ length: 6 }, (_, i) => makeMessage(`msg ${String(i)}`));

    const { provider } = createSquashProvider({ archiver, sessionId: sid, memory }, () => messages);

    const components = await provider.attach({
      pid: { id: "agent-1" as never, name: "test", type: "copilot", depth: 0 },
      manifest: {} as never,
      state: "running",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const toolEntry =
      components instanceof Map
        ? components
        : (components as { readonly components: ReadonlyMap<string, unknown> }).components;
    const tool = toolEntry.get("tool:squash") as {
      readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    const result = (await tool.execute({
      phase: "implementation",
      summary: "Implemented the feature.",
      facts: ["Uses TypeScript strict mode", "Target is Node 22"],
    })) as { readonly ok: boolean; readonly factsStored: number };

    expect(result.ok).toBe(true);
    expect(result.factsStored).toBe(2);
    expect(storeMock).toHaveBeenCalledTimes(2);
  });

  test("attaches squash skill component alongside tool", async () => {
    const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();
    const sid = "session-e2e-skill" as SessionId;

    const { provider } = createSquashProvider({ archiver, sessionId: sid }, () => []);

    const components = await provider.attach({
      pid: { id: "agent-1" as never, name: "test", type: "copilot", depth: 0 },
      manifest: {} as never,
      state: "running",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const componentMap =
      components instanceof Map
        ? components
        : (components as { readonly components: ReadonlyMap<string, unknown> }).components;

    // Both tool and skill are attached
    expect(componentMap.has("tool:squash")).toBe(true);
    expect(componentMap.has(skillToken(SQUASH_SKILL_NAME) as string)).toBe(true);

    // Skill has meaningful content
    const skill = componentMap.get(skillToken(SQUASH_SKILL_NAME) as string) as SkillComponent;
    expect(skill.name).toBe("squash");
    expect(skill.content).toContain("phase boundaries");
    expect(skill.content).toContain("When NOT to call squash");
    expect(skill.content).toContain("How to write a good summary");
  });

  test("detach clears cached components and pending queue", async () => {
    const archiver = createInMemorySnapshotChainStore<readonly InboundMessage[]>();
    const sid = "session-e2e-detach" as SessionId;
    messages = Array.from({ length: 8 }, (_, i) => makeMessage(`msg ${String(i)}`));

    const { provider } = createSquashProvider({ archiver, sessionId: sid }, () => messages);

    // Attach, execute tool, then detach
    const components1 = await provider.attach({
      pid: { id: "agent-1" as never, name: "test", type: "copilot", depth: 0 },
      manifest: {} as never,
      state: "running",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });
    const toolEntry1 =
      components1 instanceof Map
        ? components1
        : (components1 as { readonly components: ReadonlyMap<string, unknown> }).components;
    const tool = toolEntry1.get("tool:squash") as {
      readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
    };
    await tool.execute({ phase: "test", summary: "Test." });

    // Detach clears state
    await provider.detach?.({
      pid: { id: "agent-1" as never, name: "test", type: "copilot", depth: 0 },
      manifest: {} as never,
      state: "running",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    // Re-attach returns fresh components (not stale cache)
    const components2 = await provider.attach({
      pid: { id: "agent-1" as never, name: "test", type: "copilot", depth: 0 },
      manifest: {} as never,
      state: "running",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });
    expect(components2).not.toBe(components1);
  });
});
