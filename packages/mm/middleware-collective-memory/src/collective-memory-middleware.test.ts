import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  CollectiveMemory,
  ForgeStore,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { brickId, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createCollectiveMemoryMiddleware } from "./collective-memory-middleware.js";
import type { CollectiveMemoryMiddlewareConfig } from "./types.js";

const NOW = 1_700_000_000_000;

const BRICK_ID = brickId("sha256:abc123");

function createMockBrick(partial?: Partial<BrickArtifact>): BrickArtifact {
  return {
    id: BRICK_ID,
    kind: "agent",
    name: "researcher",
    description: "Research agent",
    scope: "session",
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    provenance: {
      builder: { id: "test", version: "1.0" },
      buildDefinition: { steps: [] },
    } as unknown as BrickArtifact["provenance"],
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    manifestYaml: "name: researcher",
    ...partial,
  } as BrickArtifact;
}

function createMockForgeStore(partial?: Partial<BrickArtifact>): ForgeStore {
  const stored = createMockBrick(partial);
  return {
    save: mock(async () => ({ ok: true as const, value: undefined })),
    load: mock(async () => ({ ok: true as const, value: stored })),
    search: mock(async () => ({ ok: true as const, value: [] as readonly BrickArtifact[] })),
    remove: mock(async () => ({ ok: true as const, value: undefined })),
    update: mock(async () => ({ ok: true as const, value: undefined })),
    exists: mock(async () => ({ ok: true as const, value: true })),
  } as unknown as ForgeStore;
}

function createConfig(
  overrides?: Partial<CollectiveMemoryMiddlewareConfig>,
): CollectiveMemoryMiddlewareConfig {
  return {
    forgeStore: createMockForgeStore(),
    resolveBrickId: (name: string) => (name === "researcher" ? "sha256:abc123" : undefined),
    ...overrides,
  };
}

function createSessionCtx(agentId = "researcher", runId = "run-1"): SessionContext {
  return {
    agentId,
    sessionId: "sess-1" as SessionContext["sessionId"],
    runId: runId as SessionContext["runId"],
    metadata: {},
  };
}

function createTurnCtx(agentId = "researcher", runId = "run-1"): TurnContext {
  return {
    session: createSessionCtx(agentId, runId),
    turnIndex: 0,
    turnId: "turn-1" as TurnContext["turnId"],
    messages: [],
    metadata: {},
  };
}

describe("createCollectiveMemoryMiddleware", () => {
  describe("middleware metadata", () => {
    test("has correct name and priority", () => {
      const mw = createCollectiveMemoryMiddleware(createConfig());
      expect(mw.name).toBe("koi:collective-memory");
      expect(mw.priority).toBe(305);
    });

    test("describeCapabilities returns label and description", () => {
      const mw = createCollectiveMemoryMiddleware(createConfig());
      const cap = mw.describeCapabilities(createTurnCtx());
      expect(cap?.label).toBe("collective-memory");
      expect(cap?.description).toContain("collective memory");
    });
  });

  describe("wrapToolCall — write path", () => {
    test("extracts learnings from spawn tool output and persists", async () => {
      const store = createMockForgeStore();
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));

      const req: ToolRequest = { toolId: "task", input: { agentName: "researcher" } };
      const resp: ToolResponse = { output: "[LEARNING:gotcha] Always validate API keys" };
      const next = mock(async () => resp);

      const result = await mw.wrapToolCall?.(createTurnCtx(), req, next);
      expect(result).toBe(resp);
      expect(store.update).toHaveBeenCalled();
    });

    test("skips non-spawn tool calls", async () => {
      const store = createMockForgeStore();
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));

      const req: ToolRequest = { toolId: "file_read", input: { path: "/test.txt" } };
      const resp: ToolResponse = { output: "[LEARNING:gotcha] Something" };
      const next = mock(async () => resp);

      await mw.wrapToolCall?.(createTurnCtx(), req, next);
      expect(store.update).not.toHaveBeenCalled();
    });

    test("skips when no learnings found in output", async () => {
      const store = createMockForgeStore();
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));

      const req: ToolRequest = { toolId: "task", input: { agentName: "researcher" } };
      const resp: ToolResponse = { output: "Task completed successfully." };
      const next = mock(async () => resp);

      await mw.wrapToolCall?.(createTurnCtx(), req, next);
      expect(store.update).not.toHaveBeenCalled();
    });

    test("skips when brick ID cannot be resolved", async () => {
      const store = createMockForgeStore();
      const mw = createCollectiveMemoryMiddleware(
        createConfig({ forgeStore: store, resolveBrickId: () => undefined }),
      );

      const req: ToolRequest = { toolId: "task", input: { agentName: "unknown" } };
      const resp: ToolResponse = { output: "[LEARNING:gotcha] Something important" };
      const next = mock(async () => resp);

      await mw.wrapToolCall?.(createTurnCtx(), req, next);
      expect(store.update).not.toHaveBeenCalled();
    });

    test("does not break tool chain on persistence failure", async () => {
      const store = createMockForgeStore();
      (store.load as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error("DB connection failed");
      });
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));

      const req: ToolRequest = { toolId: "task", input: { agentName: "researcher" } };
      const resp: ToolResponse = { output: "[LEARNING:gotcha] Important learning" };
      const next = mock(async () => resp);

      const result = await mw.wrapToolCall?.(createTurnCtx(), req, next);
      expect(result).toBe(resp);
    });

    test("handles object tool output via JSON.stringify", async () => {
      const store = createMockForgeStore();
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));

      const req: ToolRequest = { toolId: "task", input: { agentName: "researcher" } };
      const resp: ToolResponse = { output: { result: "[LEARNING:gotcha] Object output learning" } };
      const next = mock(async () => resp);

      await mw.wrapToolCall?.(createTurnCtx(), req, next);
      expect(store.update).toHaveBeenCalled();
    });

    test("handles null tool output gracefully", async () => {
      const store = createMockForgeStore();
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));

      const req: ToolRequest = { toolId: "task", input: { agentName: "researcher" } };
      const resp: ToolResponse = { output: null };
      const next = mock(async () => resp);

      await mw.wrapToolCall?.(createTurnCtx(), req, next);
      expect(store.update).not.toHaveBeenCalled();
    });

    test("falls back to session agentId when agentName missing from input", async () => {
      const store = createMockForgeStore();
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));

      const req: ToolRequest = { toolId: "task", input: {} };
      const resp: ToolResponse = { output: "[LEARNING:pattern] Session agent fallback" };
      const next = mock(async () => resp);

      await mw.wrapToolCall?.(createTurnCtx("researcher"), req, next);
      expect(store.update).toHaveBeenCalled();
    });

    test("triggers auto-compaction when thresholds exceeded", async () => {
      const entries = Array.from({ length: 55 }, (_, i) => ({
        id: `e${String(i)}`,
        content: `existing learning number ${String(i)}`,
        category: "heuristic" as const,
        source: { agentId: "a", runId: "r", timestamp: NOW },
        createdAt: NOW,
        accessCount: 1,
        lastAccessedAt: NOW,
      }));
      const memory: CollectiveMemory = { entries, totalTokens: 9000, generation: 1 };
      const store = createMockForgeStore({ collectiveMemory: memory });
      const mw = createCollectiveMemoryMiddleware(
        createConfig({ forgeStore: store, maxEntries: 50, autoCompact: true }),
      );

      const req: ToolRequest = { toolId: "task", input: { agentName: "researcher" } };
      const resp: ToolResponse = { output: "[LEARNING:gotcha] Trigger compaction" };
      const next = mock(async () => resp);

      await mw.wrapToolCall?.(createTurnCtx(), req, next);
      expect(store.update).toHaveBeenCalled();
    });
  });

  describe("wrapModelCall — read path", () => {
    test("injects collective memory on first model call", async () => {
      const memory: CollectiveMemory = {
        entries: [
          {
            id: "e1",
            content: "Always use --frozen-lockfile in CI",
            category: "gotcha",
            source: { agentId: "a", runId: "r", timestamp: NOW },
            createdAt: NOW,
            accessCount: 3,
            lastAccessedAt: NOW,
          },
        ],
        totalTokens: 100,
        generation: 1,
      };
      const store = createMockForgeStore({ collectiveMemory: memory });
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));

      await mw.onSessionStart?.(createSessionCtx());

      const req: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const expected: ModelResponse = { content: "Response", model: "test-model" };
      const next = mock(async (r: ModelRequest) => {
        expect(r.messages.length).toBe(2);
        expect(r.messages[0]?.senderId).toBe("system:collective-memory");
        return expected;
      });

      const result = await mw.wrapModelCall?.(createTurnCtx(), req, next);
      expect(result).toBe(expected);
    });

    test("injects only once per session (one-shot)", async () => {
      const memory: CollectiveMemory = {
        entries: [
          {
            id: "e1",
            content: "Some learning",
            category: "heuristic",
            source: { agentId: "a", runId: "r", timestamp: NOW },
            createdAt: NOW,
            accessCount: 1,
            lastAccessedAt: NOW,
          },
        ],
        totalTokens: 10,
        generation: 1,
      };
      const store = createMockForgeStore({ collectiveMemory: memory });
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));
      await mw.onSessionStart?.(createSessionCtx());

      const req: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const resp: ModelResponse = { content: "", model: "test-model" };
      const next = mock(async () => resp);
      const ctx = createTurnCtx();

      await mw.wrapModelCall?.(ctx, req, next);
      await mw.wrapModelCall?.(ctx, req, next);

      expect(((next.mock.calls[0] as unknown[])[0] as ModelRequest).messages).toHaveLength(2);
      expect(((next.mock.calls[1] as unknown[])[0] as ModelRequest).messages).toHaveLength(1);
    });

    test("skips injection when brick has no collective memory", async () => {
      const store = createMockForgeStore();
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));
      await mw.onSessionStart?.(createSessionCtx());

      const req: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const next = mock(async () => ({ content: "", model: "test-model" }) satisfies ModelResponse);

      await mw.wrapModelCall?.(createTurnCtx(), req, next);
      expect(((next.mock.calls[0] as unknown[])[0] as ModelRequest).messages).toHaveLength(1);
    });

    test("skips injection when brick ID cannot be resolved", async () => {
      const mw = createCollectiveMemoryMiddleware(
        createConfig({ resolveBrickId: () => undefined }),
      );
      await mw.onSessionStart?.(createSessionCtx("unknown"));

      const req: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const next = mock(async () => ({ content: "", model: "test-model" }) satisfies ModelResponse);

      await mw.wrapModelCall?.(createTurnCtx("unknown"), req, next);
      expect(((next.mock.calls[0] as unknown[])[0] as ModelRequest).messages).toHaveLength(1);
    });

    test("does not break model call on memory load failure", async () => {
      const store = createMockForgeStore();
      (store.load as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error("Store unavailable");
      });
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));
      await mw.onSessionStart?.(createSessionCtx());

      const req: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const resp: ModelResponse = { content: "", model: "test-model" };
      const next = mock(async () => resp);

      const result = await mw.wrapModelCall?.(createTurnCtx(), req, next);
      expect(result).toBe(resp);
    });
  });

  describe("onSessionEnd — LLM extraction", () => {
    test("calls LLM with accumulated spawn outputs at session end", async () => {
      const store = createMockForgeStore();
      const modelCall = mock(
        async (_req: ModelRequest): Promise<ModelResponse> => ({
          content: JSON.stringify([{ content: "Always check return values", category: "gotcha" }]),
          model: "haiku",
        }),
      );
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store, modelCall }));

      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(
        async () => ({ output: "Task completed with useful insights" }) satisfies ToolResponse,
      );
      await mw.wrapToolCall?.(
        createTurnCtx(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );

      await mw.onSessionEnd?.(createSessionCtx());

      expect(modelCall).toHaveBeenCalledTimes(1);
      expect(store.update).toHaveBeenCalled();
    });

    test("does not call LLM when no outputs accumulated", async () => {
      const modelCall = mock(
        async (): Promise<ModelResponse> => ({ content: "[]", model: "haiku" }),
      );
      const mw = createCollectiveMemoryMiddleware(createConfig({ modelCall }));

      await mw.onSessionStart?.(createSessionCtx());
      await mw.onSessionEnd?.(createSessionCtx());

      expect(modelCall).not.toHaveBeenCalled();
    });

    test("does not call LLM when modelCall not configured", async () => {
      const store = createMockForgeStore();
      const mw = createCollectiveMemoryMiddleware(createConfig({ forgeStore: store }));

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(
        async () => ({ output: "[LEARNING:gotcha] something" }) satisfies ToolResponse,
      );
      await mw.wrapToolCall?.(
        createTurnCtx(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );
      await mw.onSessionEnd?.(createSessionCtx());
      // No assertion on LLM call — just verifying no error thrown
    });

    test("LLM extraction failure does not break session cleanup", async () => {
      const modelCall = mock(async (): Promise<ModelResponse> => {
        throw new Error("LLM service unavailable");
      });
      const mw = createCollectiveMemoryMiddleware(createConfig({ modelCall }));

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(async () => ({ output: "Some output" }) satisfies ToolResponse);
      await mw.wrapToolCall?.(
        createTurnCtx(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );

      await expect(mw.onSessionEnd?.(createSessionCtx())).resolves.toBeUndefined();
    });

    test("resets session outputs after onSessionEnd", async () => {
      const modelCall = mock(
        async (): Promise<ModelResponse> => ({ content: "[]", model: "haiku" }),
      );
      const mw = createCollectiveMemoryMiddleware(createConfig({ modelCall }));

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(async () => ({ output: "First session output" }) satisfies ToolResponse);
      await mw.wrapToolCall?.(
        createTurnCtx(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );
      await mw.onSessionEnd?.(createSessionCtx());
      expect(modelCall).toHaveBeenCalledTimes(1);

      modelCall.mockClear();
      await mw.onSessionStart?.(createSessionCtx());
      await mw.onSessionEnd?.(createSessionCtx());
      expect(modelCall).not.toHaveBeenCalled();
    });

    test("passes extractionModel and extractionMaxTokens to model call", async () => {
      const store = createMockForgeStore();
      const modelCall = mock(
        async (): Promise<ModelResponse> => ({ content: "[]", model: "haiku" }),
      );
      const mw = createCollectiveMemoryMiddleware(
        createConfig({
          forgeStore: store,
          modelCall,
          extractionModel: "claude-haiku-4-5",
          extractionMaxTokens: 2048,
        }),
      );

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(async () => ({ output: "Some output" }) satisfies ToolResponse);
      await mw.wrapToolCall?.(
        createTurnCtx(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );
      await mw.onSessionEnd?.(createSessionCtx());

      const callArg = (modelCall.mock.calls[0] as unknown[])[0] as ModelRequest;
      expect(callArg.model).toBe("claude-haiku-4-5");
      expect(callArg.maxTokens).toBe(2048);
    });

    test("skips persistence when brick ID cannot be resolved in session end", async () => {
      const store = createMockForgeStore();
      const modelCall = mock(
        async (): Promise<ModelResponse> => ({
          content: JSON.stringify([{ content: "A learning", category: "gotcha" }]),
          model: "haiku",
        }),
      );
      const mw = createCollectiveMemoryMiddleware(
        createConfig({ forgeStore: store, modelCall, resolveBrickId: () => undefined }),
      );

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(async () => ({ output: "Some output" }) satisfies ToolResponse);
      await mw.wrapToolCall?.(createTurnCtx(), { toolId: "task", input: {} }, next);

      (store.update as ReturnType<typeof mock>).mockClear();
      await mw.onSessionEnd?.(createSessionCtx());

      expect(modelCall).toHaveBeenCalledTimes(1);
      expect(store.update).not.toHaveBeenCalled();
    });
  });
});
