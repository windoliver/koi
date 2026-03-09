import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest, ModelResponse, ToolResponse } from "@koi/core/middleware";
import { testMiddlewareContract } from "@koi/test-utils";
import { createAceMiddleware } from "./ace.js";
import type { CuratorAdapter } from "./curator.js";
import { isLlmPipelineEnabled } from "./pipeline.js";
import type { ReflectorAdapter } from "./reflector.js";
import {
  createInMemoryPlaybookStore,
  createInMemoryStructuredPlaybookStore,
  createInMemoryTrajectoryStore,
} from "./stores.js";

function createModelRequest(): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text" as const, text: "test" }],
        senderId: "test-sender",
        timestamp: 1000,
      } satisfies InboundMessage,
    ],
    model: "test-model",
  };
}

function createModelResponse(): ModelResponse {
  return {
    content: "test response",
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

function createToolResponse(): ToolResponse {
  return { output: "test output" };
}

describe("createAceMiddleware", () => {
  const baseConfig = () => ({
    trajectoryStore: createInMemoryTrajectoryStore(),
    playbookStore: createInMemoryPlaybookStore(),
    clock: () => 1000,
  });

  // --- Contract tests ---
  describe("middleware contract", () => {
    testMiddlewareContract({
      createMiddleware: () => createAceMiddleware(baseConfig()),
    });
  });

  test("returns middleware with name 'ace'", () => {
    const mw = createAceMiddleware(baseConfig());
    expect(mw.name).toBe("ace");
  });

  test("returns middleware with priority 350", () => {
    const mw = createAceMiddleware(baseConfig());
    expect(mw.priority).toBe(350);
  });

  test("wrapModelCall records trajectory entry on success", async () => {
    const recorded: unknown[] = [];
    const mw = createAceMiddleware({
      ...baseConfig(),
      onRecord: (entry) => recorded.push(entry),
    });
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "r:t0" as never,
      messages: [],
      metadata: {},
    };

    await mw.wrapModelCall?.(ctx, createModelRequest(), async () => createModelResponse());

    expect(recorded).toHaveLength(1);
    expect((recorded[0] as Record<string, unknown>).kind).toBe("model_call");
    expect((recorded[0] as Record<string, unknown>).outcome).toBe("success");
  });

  test("wrapToolCall records success on normal execution", async () => {
    const recorded: unknown[] = [];
    const mw = createAceMiddleware({
      ...baseConfig(),
      onRecord: (entry) => recorded.push(entry),
    });
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "r:t0" as never,
      messages: [],
      metadata: {},
    };

    await mw.wrapToolCall?.(ctx, { toolId: "test-tool", input: {} }, async () =>
      createToolResponse(),
    );

    expect(recorded).toHaveLength(1);
    expect((recorded[0] as Record<string, unknown>).kind).toBe("tool_call");
    expect((recorded[0] as Record<string, unknown>).outcome).toBe("success");
  });

  test("wrapToolCall records failure and re-throws on error", async () => {
    const recorded: unknown[] = [];
    const mw = createAceMiddleware({
      ...baseConfig(),
      onRecord: (entry) => recorded.push(entry),
    });
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "r:t0" as never,
      messages: [],
      metadata: {},
    };

    await expect(
      mw.wrapToolCall?.(ctx, { toolId: "test-tool", input: {} }, async () => {
        throw new Error("tool failed");
      }),
    ).rejects.toThrow("tool failed");

    expect(recorded).toHaveLength(1);
    expect((recorded[0] as Record<string, unknown>).outcome).toBe("failure");
  });

  test("wrapModelCall injects playbooks when available", async () => {
    const playbookStore = createInMemoryPlaybookStore();
    await playbookStore.save({
      id: "pb-1",
      title: "Test Strategy",
      strategy: "Use caching",
      tags: [],
      confidence: 0.9,
      source: "curated",
      createdAt: 1000,
      updatedAt: 1000,
      sessionCount: 1,
    });

    const injected: unknown[] = [];
    const mw = createAceMiddleware({
      ...baseConfig(),
      playbookStore,
      onInject: (pbs) => injected.push(...pbs),
    });
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "r:t0" as never,
      messages: [],
      metadata: {},
    };

    let capturedRequest: ModelRequest | undefined;
    await mw.wrapModelCall?.(ctx, createModelRequest(), async (req) => {
      capturedRequest = req;
      return createModelResponse();
    });

    expect(injected).toHaveLength(1);
    expect(capturedRequest).toBeDefined();
    // The enriched request should have an extra message prepended
    expect(capturedRequest?.messages.length).toBe(2);
    const first = capturedRequest?.messages[0];
    expect(first?.senderId).toBe("system:ace");
  });

  test("wrapModelCall passes through when no playbooks match", async () => {
    const mw = createAceMiddleware(baseConfig());
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "r:t0" as never,
      messages: [],
      metadata: {},
    };

    let capturedRequest: ModelRequest | undefined;
    await mw.wrapModelCall?.(ctx, createModelRequest(), async (req) => {
      capturedRequest = req;
      return createModelResponse();
    });

    // No extra messages — original request passed through
    expect(capturedRequest?.messages).toHaveLength(1);
  });

  test("onSessionEnd flushes buffer and persists trajectory", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const mw = createAceMiddleware({
      ...baseConfig(),
      trajectoryStore,
    });
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "r:t0" as never,
      messages: [],
      metadata: {},
    };

    // Record some entries via wrapModelCall
    await mw.wrapModelCall?.(ctx, createModelRequest(), async () => createModelResponse());

    // End session
    await mw.onSessionEnd?.({
      agentId: "a",
      sessionId: "s" as never,
      runId: "r" as never,
      metadata: {},
    });

    const entries = await trajectoryStore.getSession("s");
    expect(entries.length).toBeGreaterThan(0);
  });

  test("onSessionEnd with no entries is a no-op", async () => {
    const curated: unknown[] = [];
    const mw = createAceMiddleware({
      ...baseConfig(),
      onCurate: (c) => curated.push(...c),
    });

    await mw.onSessionEnd?.({
      agentId: "a",
      sessionId: "s" as never,
      runId: "r" as never,
      metadata: {},
    });

    expect(curated).toHaveLength(0);
  });

  test("wrapModelCall records failure and re-throws on model error", async () => {
    const recorded: unknown[] = [];
    const mw = createAceMiddleware({
      ...baseConfig(),
      onRecord: (entry) => recorded.push(entry),
    });
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "r:t0" as never,
      messages: [],
      metadata: {},
    };

    await expect(
      mw.wrapModelCall?.(ctx, createModelRequest(), async () => {
        throw new Error("model failed");
      }),
    ).rejects.toThrow("model failed");

    expect(recorded).toHaveLength(1);
    expect((recorded[0] as Record<string, unknown>).kind).toBe("model_call");
    expect((recorded[0] as Record<string, unknown>).outcome).toBe("failure");
    expect((recorded[0] as Record<string, unknown>).identifier).toBe("test-model");
  });

  test("wrapModelCall uses 'unknown' identifier when model is not set on request", async () => {
    const recorded: unknown[] = [];
    const mw = createAceMiddleware({
      ...baseConfig(),
      onRecord: (entry) => recorded.push(entry),
    });
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "r:t0" as never,
      messages: [],
      metadata: {},
    };

    const requestNoModel: ModelRequest = {
      messages: createModelRequest().messages,
    };

    await expect(
      mw.wrapModelCall?.(ctx, requestNoModel, async () => {
        throw new Error("model failed");
      }),
    ).rejects.toThrow("model failed");

    expect((recorded[0] as Record<string, unknown>).identifier).toBe("unknown");
  });

  test("onSessionEnd wraps store errors with context", async () => {
    const failingStore = {
      ...createInMemoryTrajectoryStore(),
      async append(): Promise<void> {
        throw new Error("disk full");
      },
    };
    const mw = createAceMiddleware({
      ...baseConfig(),
      trajectoryStore: failingStore,
    });
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "r:t0" as never,
      messages: [],
      metadata: {},
    };

    // Record an entry so buffer is non-empty
    await mw.wrapModelCall?.(ctx, createModelRequest(), async () => createModelResponse());

    await expect(
      mw.onSessionEnd?.({
        agentId: "a",
        sessionId: "s" as never,
        runId: "r" as never,
        metadata: {},
      }),
    ).rejects.toThrow("ACE: onSessionEnd failed for session s");
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const mw = createAceMiddleware(baseConfig());
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns undefined when no active playbooks and no forge nudge", () => {
      const mw = createAceMiddleware(baseConfig());
      const ctx = {
        session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
        turnIndex: 0,
        turnId: "r:t0" as never,
        messages: [],
        metadata: {},
      };
      const result = mw.describeCapabilities?.(ctx);
      expect(result).toBeUndefined();
    });
  });

  // --- Stat-mode regression tests ---
  describe("stat-mode regression", () => {
    test("no reflector/curator config uses stat pipeline", () => {
      const config = baseConfig();
      expect(isLlmPipelineEnabled(config)).toBe(false);
    });

    test("stat pipeline produces playbooks via onSessionEnd", async () => {
      const playbookStore = createInMemoryPlaybookStore();
      const mw = createAceMiddleware({
        ...baseConfig(),
        playbookStore,
      });
      const ctx = {
        session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
        turnIndex: 0,
        turnId: "r:t0" as never,
        messages: [],
        metadata: {},
      };

      // Record entries
      for (let i = 0; i < 5; i++) {
        await mw.wrapModelCall?.({ ...ctx, turnIndex: i }, createModelRequest(), async () =>
          createModelResponse(),
        );
      }

      await mw.onSessionEnd?.({
        agentId: "a",
        sessionId: "s" as never,
        runId: "r" as never,
        metadata: {},
      });

      const playbooks = await playbookStore.list();
      expect(playbooks.length).toBeGreaterThan(0);
      // Verify stat-based playbook format
      for (const pb of playbooks) {
        expect(pb.id).toMatch(/^ace:(model_call|tool_call):/);
        expect(pb.source).toBe("curated");
      }
    });
  });

  // --- Feature flag tests ---
  describe("pipeline selection", () => {
    test("LLM pipeline enabled when reflector + curator + store configured", () => {
      const mockReflector: ReflectorAdapter = {
        analyze: async () => ({ rootCause: "", keyInsight: "", bulletTags: [] }),
      };
      const mockCurator: CuratorAdapter = {
        curate: async () => [],
      };
      const config = {
        ...baseConfig(),
        reflector: mockReflector,
        curator: mockCurator,
        structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
      };
      expect(isLlmPipelineEnabled(config)).toBe(true);
    });

    test("LLM pipeline disabled when only reflector configured", () => {
      const mockReflector: ReflectorAdapter = {
        analyze: async () => ({ rootCause: "", keyInsight: "", bulletTags: [] }),
      };
      const config = { ...baseConfig(), reflector: mockReflector };
      expect(isLlmPipelineEnabled(config)).toBe(false);
    });

    test("LLM pipeline disabled when only curator configured", () => {
      const mockCurator: CuratorAdapter = {
        curate: async () => [],
      };
      const config = { ...baseConfig(), curator: mockCurator };
      expect(isLlmPipelineEnabled(config)).toBe(false);
    });
  });

  // --- Structured playbook budget tests ---
  describe("structured playbook budget", () => {
    test("structured playbooks respect shared budget with stat playbooks", async () => {
      const playbookStore = createInMemoryPlaybookStore();
      // Stat playbook: ~100 tokens (400 chars)
      await playbookStore.save({
        id: "pb-stat",
        title: "Stat Strategy",
        strategy: "a".repeat(400),
        tags: [],
        confidence: 0.9,
        source: "curated",
        createdAt: 1000,
        updatedAt: 1000,
        sessionCount: 1,
      });

      const structuredStore = createInMemoryStructuredPlaybookStore();
      // Structured playbook: ~250 tokens (1000 chars)
      await structuredStore.save({
        id: "sp-large",
        title: "Large Structured",
        sections: [
          {
            name: "Big Section",
            slug: "big",
            bullets: [
              {
                id: "[big-00001]",
                content: "x".repeat(1000),
                helpful: 1,
                harmful: 0,
                createdAt: 1000,
                updatedAt: 1000,
              },
            ],
          },
        ],
        tags: [],
        source: "curated",
        createdAt: 1000,
        updatedAt: 1000,
        sessionCount: 1,
      });

      const mockReflector = {
        analyze: async () => ({ rootCause: "", keyInsight: "", bulletTags: [] }),
      };
      const mockCurator = { curate: async () => [] };

      const mw = createAceMiddleware({
        ...baseConfig(),
        playbookStore,
        structuredPlaybookStore: structuredStore,
        reflector: mockReflector,
        curator: mockCurator,
        maxInjectionTokens: 120, // Only enough for the stat playbook (~100 tokens)
      });

      const ctx = {
        session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
        turnIndex: 0,
        turnId: "r:t0" as never,
        messages: [],
        metadata: {},
      };

      let capturedRequest: ModelRequest | undefined;
      await mw.wrapModelCall?.(ctx, createModelRequest(), async (req) => {
        capturedRequest = req;
        return createModelResponse();
      });

      expect(capturedRequest).toBeDefined();
      // The enriched request should have the stat playbook but not the structured one
      // (budget exhausted by stat playbook)
      const injected = capturedRequest?.messages[0];
      expect(injected?.senderId).toBe("system:ace");
      if (injected?.content[0]?.kind === "text") {
        expect(injected.content[0].text).toContain("Stat Strategy");
        expect(injected.content[0].text).not.toContain("Large Structured");
      }
    });
  });

  // --- Bullet ID extraction tests ---
  describe("citation tracking", () => {
    test("wrapModelCall extracts bullet IDs from model response", async () => {
      const recorded: unknown[] = [];
      const mw = createAceMiddleware({
        ...baseConfig(),
        onRecord: (entry) => recorded.push(entry),
      });
      const ctx = {
        session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
        turnIndex: 0,
        turnId: "r:t0" as never,
        messages: [],
        metadata: {},
      };

      await mw.wrapModelCall?.(ctx, createModelRequest(), async () => ({
        content: "Per [str-00001] and [err-00002], use caching.",
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 20 },
      }));

      expect(recorded).toHaveLength(1);
      const entry = recorded[0] as Record<string, unknown>;
      expect(entry.bulletIds).toEqual(["[str-00001]", "[err-00002]"]);
    });
  });
});
