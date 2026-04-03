import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  BrickId,
  CollectiveMemory,
  ForgeStore,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createCollectiveMemoryMiddleware } from "./collective-memory-middleware.js";
import type { CollectiveMemoryMiddlewareConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function createMockForgeStore(brick?: Partial<BrickArtifact>): ForgeStore {
  const stored: BrickArtifact = {
    id: "sha256:abc123" as BrickId,
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
    ...brick,
  } as BrickArtifact;

  // let justified: mutable tracking for test assertions
  let lastUpdate: unknown;

  return {
    save: mock(async () => ({ ok: true as const, value: undefined })),
    load: mock(async () => ({ ok: true as const, value: stored })),
    search: mock(async () => ({ ok: true as const, value: [] as readonly BrickArtifact[] })),
    remove: mock(async () => ({ ok: true as const, value: undefined })),
    update: mock(async (_id: BrickId, updates: unknown) => {
      lastUpdate = updates;
      return { ok: true as const, value: undefined };
    }),
    exists: mock(async () => ({ ok: true as const, value: true })),
    // Expose for test assertions
    get _lastUpdate() {
      return lastUpdate;
    },
  } as unknown as ForgeStore & { readonly _lastUpdate: unknown };
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

function createTurnContext(agentId = "researcher", runId = "run-1"): TurnContext {
  return {
    session: {
      agentId,
      sessionId: "sess-1" as TurnContext["session"]["sessionId"],
      runId: runId as TurnContext["session"]["runId"],
      metadata: {},
    },
    turnIndex: 0,
    turnId: "turn-1" as TurnContext["turnId"],
    messages: [],
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// wrapToolCall — write path
// ---------------------------------------------------------------------------

describe("createCollectiveMemoryMiddleware", () => {
  describe("wrapToolCall (write path)", () => {
    test("extracts learnings from spawn tool output and persists", async () => {
      const store = createMockForgeStore();
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "task",
        input: { agentName: "researcher" },
      };

      const response: ToolResponse = {
        output: "[LEARNING:gotcha] Always validate API keys before calling",
      };

      const next = mock(async () => response);
      const ctx = createTurnContext();

      const result = await middleware.wrapToolCall?.(ctx, request, next);

      expect(result).toBe(response);
      expect(next).toHaveBeenCalledTimes(1);
      // Store should have been called with update
      expect(store.update).toHaveBeenCalled();
    });

    test("skips non-spawn tool calls", async () => {
      const store = createMockForgeStore();
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "file_read",
        input: { path: "/test.txt" },
      };
      const response: ToolResponse = { output: "[LEARNING:gotcha] Something" };
      const next = mock(async () => response);

      await middleware.wrapToolCall?.(createTurnContext(), request, next);

      expect(store.update).not.toHaveBeenCalled();
    });

    test("skips when no learnings found in output", async () => {
      const store = createMockForgeStore();
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "task",
        input: { agentName: "researcher" },
      };
      const response: ToolResponse = { output: "Task completed successfully." };
      const next = mock(async () => response);

      await middleware.wrapToolCall?.(createTurnContext(), request, next);

      expect(store.update).not.toHaveBeenCalled();
    });

    test("skips when brick ID cannot be resolved", async () => {
      const store = createMockForgeStore();
      const config = createConfig({
        forgeStore: store,
        resolveBrickId: () => undefined,
      });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "task",
        input: { agentName: "unknown" },
      };
      const response: ToolResponse = {
        output: "[LEARNING:gotcha] Something important",
      };
      const next = mock(async () => response);

      await middleware.wrapToolCall?.(createTurnContext(), request, next);

      expect(store.update).not.toHaveBeenCalled();
    });

    test("does not break tool chain on persistence failure", async () => {
      const store = createMockForgeStore();
      (store.load as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error("DB connection failed");
      });
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "task",
        input: { agentName: "researcher" },
      };
      const response: ToolResponse = {
        output: "[LEARNING:gotcha] Important learning",
      };
      const next = mock(async () => response);

      // Should not throw
      const result = await middleware.wrapToolCall?.(createTurnContext(), request, next);
      expect(result).toBe(response);
    });
  });

  // ---------------------------------------------------------------------------
  // wrapModelCall — read path
  // ---------------------------------------------------------------------------

  describe("wrapModelCall (read path)", () => {
    test("injects collective memory on first model call", async () => {
      const memory: CollectiveMemory = {
        entries: [
          {
            id: "e1",
            content: "Always use --frozen-lockfile in CI",
            category: "gotcha",
            source: { agentId: "agent-1", runId: "run-1", timestamp: NOW },
            createdAt: NOW,
            accessCount: 3,
            lastAccessedAt: NOW,
          },
        ],
        totalTokens: 100,
        generation: 1,
      };
      const store = createMockForgeStore({ collectiveMemory: memory });
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      // Initialize session
      await middleware.onSessionStart?.({
        agentId: "researcher",
        sessionId: "sess-1",
        runId: "run-1",
        metadata: {},
      } as unknown as Parameters<NonNullable<KoiMiddleware["onSessionStart"]>>[0]);

      const request: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const expectedResponse: ModelResponse = {
        content: "Response",
        model: "test-model",
        metadata: {},
      };
      const next = mock(async (req: ModelRequest) => {
        // Verify system message was prepended
        expect(req.messages.length).toBe(2);
        expect(req.messages[0]?.senderId).toBe("system:collective-memory");
        return expectedResponse;
      });

      const result = await middleware.wrapModelCall?.(createTurnContext(), request, next);
      expect(result).toBe(expectedResponse);
    });

    test("does not inject on second model call (one-shot)", async () => {
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
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.({
        agentId: "researcher",
        sessionId: "s",
        runId: "r",
        metadata: {},
      } as unknown as Parameters<NonNullable<KoiMiddleware["onSessionStart"]>>[0]);

      const request: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const response: ModelResponse = { content: "", model: "test-model", metadata: {} };
      const next = mock(async () => response);
      const ctx = createTurnContext();

      // First call — injects
      await middleware.wrapModelCall?.(ctx, request, next);
      // Second call — skips injection
      await middleware.wrapModelCall?.(ctx, request, next);

      // First call has 2 messages (injected + original), second has 1
      expect((next.mock.calls[0] as unknown[])[0]).toHaveProperty("messages");
      expect(((next.mock.calls[0] as unknown[])[0] as ModelRequest).messages).toHaveLength(2);
      expect(((next.mock.calls[1] as unknown[])[0] as ModelRequest).messages).toHaveLength(1);
    });

    test("skips injection when brick has no collective memory", async () => {
      const store = createMockForgeStore(); // no collectiveMemory field
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.({
        agentId: "researcher",
        sessionId: "s",
        runId: "r",
        metadata: {},
      } as unknown as Parameters<NonNullable<KoiMiddleware["onSessionStart"]>>[0]);

      const request: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const response: ModelResponse = { content: "", model: "test-model", metadata: {} };
      const next = mock(async () => response);

      await middleware.wrapModelCall?.(createTurnContext(), request, next);

      // Should pass through without injection
      expect(((next.mock.calls[0] as unknown[])[0] as ModelRequest).messages).toHaveLength(1);
    });

    test("skips injection when brick ID cannot be resolved", async () => {
      const config = createConfig({
        resolveBrickId: () => undefined,
      });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.({
        agentId: "unknown",
        sessionId: "s",
        runId: "r",
        metadata: {},
      } as unknown as Parameters<NonNullable<KoiMiddleware["onSessionStart"]>>[0]);

      const request: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const response: ModelResponse = { content: "", model: "test-model", metadata: {} };
      const next = mock(async () => response);

      await middleware.wrapModelCall?.(createTurnContext("unknown"), request, next);

      expect(((next.mock.calls[0] as unknown[])[0] as ModelRequest).messages).toHaveLength(1);
    });

    test("does not break model call on memory load failure", async () => {
      const store = createMockForgeStore();
      (store.load as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error("Store unavailable");
      });
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.({
        agentId: "researcher",
        sessionId: "s",
        runId: "r",
        metadata: {},
      } as unknown as Parameters<NonNullable<KoiMiddleware["onSessionStart"]>>[0]);

      const request: ModelRequest = {
        messages: [
          { content: [{ kind: "text", text: "Hello" }], senderId: "user", timestamp: NOW },
        ],
      };
      const response: ModelResponse = { content: "", model: "test-model", metadata: {} };
      const next = mock(async () => response);

      // Should not throw
      const result = await middleware.wrapModelCall?.(createTurnContext(), request, next);
      expect(result).toBe(response);
    });
  });

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  describe("middleware metadata", () => {
    test("has correct name and priority", () => {
      const middleware = createCollectiveMemoryMiddleware(createConfig());
      expect(middleware.name).toBe("koi:collective-memory");
      expect(middleware.priority).toBe(305);
    });

    test("describeCapabilities returns label and description", () => {
      const middleware = createCollectiveMemoryMiddleware(createConfig());
      const ctx = createTurnContext();
      const capabilities = middleware.describeCapabilities(ctx);
      expect(capabilities).toBeDefined();
      expect(capabilities?.label).toBe("collective-memory");
      expect(capabilities?.description).toContain("collective memory");
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    test("handles non-string tool output (object)", async () => {
      const store = createMockForgeStore();
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "task",
        input: { agentName: "researcher" },
      };
      const response: ToolResponse = {
        output: { result: "[LEARNING:gotcha] Object output learning" },
      };
      const next = mock(async () => response);

      await middleware.wrapToolCall?.(createTurnContext(), request, next);
      // Should have extracted from JSON.stringify of the object
      expect(store.update).toHaveBeenCalled();
    });

    test("handles null tool output gracefully", async () => {
      const store = createMockForgeStore();
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "task",
        input: { agentName: "researcher" },
      };
      const response: ToolResponse = { output: null };
      const next = mock(async () => response);

      await middleware.wrapToolCall?.(createTurnContext(), request, next);
      expect(store.update).not.toHaveBeenCalled();
    });

    test("handles undefined tool output gracefully", async () => {
      const store = createMockForgeStore();
      const config = createConfig({ forgeStore: store });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "task",
        input: { agentName: "researcher" },
      };
      const response: ToolResponse = { output: undefined };
      const next = mock(async () => response);

      await middleware.wrapToolCall?.(createTurnContext(), request, next);
      expect(store.update).not.toHaveBeenCalled();
    });

    test("uses agentId from session when agentName not in tool input", async () => {
      const store = createMockForgeStore();
      const config = createConfig({
        forgeStore: store,
        resolveBrickId: (name: string) => (name === "researcher" ? "sha256:abc123" : undefined),
      });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "task",
        input: {}, // no agentName
      };
      const response: ToolResponse = {
        output: "[LEARNING:pattern] Session agent fallback",
      };
      const next = mock(async () => response);

      await middleware.wrapToolCall?.(createTurnContext("researcher"), request, next);
      expect(store.update).toHaveBeenCalled();
    });

    test("triggers auto-compaction when thresholds exceeded", async () => {
      // Create a brick with many entries near the threshold
      const entries = Array.from({ length: 55 }, (_, i) => ({
        id: `e${String(i)}`,
        content: `existing learning number ${String(i)}`,
        category: "heuristic" as const,
        source: { agentId: "a", runId: "r", timestamp: NOW },
        createdAt: NOW,
        accessCount: 1,
        lastAccessedAt: NOW,
      }));
      const memory: CollectiveMemory = {
        entries,
        totalTokens: 9000,
        generation: 1,
      };
      const store = createMockForgeStore({ collectiveMemory: memory });
      const config = createConfig({
        forgeStore: store,
        maxEntries: 50,
        autoCompact: true,
      });
      const middleware = createCollectiveMemoryMiddleware(config);

      const request: ToolRequest = {
        toolId: "task",
        input: { agentName: "researcher" },
      };
      const response: ToolResponse = {
        output: "[LEARNING:gotcha] New learning to trigger compaction",
      };
      const next = mock(async () => response);

      await middleware.wrapToolCall?.(createTurnContext(), request, next);
      expect(store.update).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // onSessionEnd — LLM extraction
  // ---------------------------------------------------------------------------

  describe("onSessionEnd (LLM extraction)", () => {
    function createSessionContext(agentId = "researcher", runId = "run-1"): SessionContext {
      return {
        agentId,
        sessionId: "sess-1",
        runId,
        metadata: {},
      } as unknown as SessionContext;
    }

    test("calls LLM with accumulated outputs on session end", async () => {
      const store = createMockForgeStore();
      const modelCall = mock(
        async (_req: ModelRequest): Promise<ModelResponse> => ({
          content: JSON.stringify([{ content: "Always check return values", category: "gotcha" }]),
          model: "haiku",
        }),
      );
      const config = createConfig({ forgeStore: store, modelCall });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());

      // Simulate spawn tool calls that accumulate outputs
      const next = mock(async () => ({ output: "Task completed with useful insights" }));
      await middleware.wrapToolCall?.(
        createTurnContext(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );
      await middleware.wrapToolCall?.(
        createTurnContext(),
        { toolId: "delegate", input: { agentName: "researcher" } },
        next,
      );

      // Trigger session end
      await middleware.onSessionEnd?.(createSessionContext());

      expect(modelCall).toHaveBeenCalledTimes(1);
      // Verify the prompt includes accumulated outputs
      const callArg = (modelCall.mock.calls[0] as unknown[])[0] as ModelRequest;
      expect(callArg.messages[0]?.content[0]).toHaveProperty("text");
      const promptText = (callArg.messages[0]?.content[0] as { readonly text: string }).text;
      expect(promptText).toContain("Task completed with useful insights");
      // Store should be updated with extracted learnings
      expect(store.update).toHaveBeenCalled();
    });

    test("does not call LLM when no outputs accumulated", async () => {
      const modelCall = mock(
        async (_req: ModelRequest): Promise<ModelResponse> => ({
          content: "[]",
          model: "haiku",
        }),
      );
      const config = createConfig({ modelCall });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());
      await middleware.onSessionEnd?.(createSessionContext());

      expect(modelCall).not.toHaveBeenCalled();
    });

    test("does not call LLM when modelCall not configured", async () => {
      const store = createMockForgeStore();
      const config = createConfig({ forgeStore: store }); // no modelCall
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());

      // Simulate spawn tool calls
      const next = mock(async () => ({ output: "[LEARNING:gotcha] something" }));
      await middleware.wrapToolCall?.(
        createTurnContext(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );

      await middleware.onSessionEnd?.(createSessionContext());

      // Only regex-based updates from wrapToolCall, no LLM call
      // The store.update calls are from regex extraction only
    });

    test("does not accumulate outputs when modelCall not configured", async () => {
      const store = createMockForgeStore();
      const config = createConfig({ forgeStore: store }); // no modelCall
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());

      // Even with spawn tool outputs, no accumulation should happen
      const next = mock(async () => ({ output: "No learnings here" }));
      await middleware.wrapToolCall?.(
        createTurnContext(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );

      // onSessionEnd should be a no-op
      await middleware.onSessionEnd?.(createSessionContext());
      // No errors, no additional store calls beyond wrapToolCall
    });

    test("persists LLM-extracted entries to ForgeStore", async () => {
      const store = createMockForgeStore();
      const modelCall = mock(
        async (_req: ModelRequest): Promise<ModelResponse> => ({
          content: JSON.stringify([
            { content: "Use retry with jitter", category: "pattern" },
            { content: "Rate limit is 100/min", category: "context" },
          ]),
          model: "haiku",
        }),
      );
      const config = createConfig({ forgeStore: store, modelCall });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());

      const next = mock(async () => ({ output: "Worker discovered rate limits" }));
      await middleware.wrapToolCall?.(
        createTurnContext(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );

      // Reset mock to isolate onSessionEnd calls
      (store.update as ReturnType<typeof mock>).mockClear();

      await middleware.onSessionEnd?.(createSessionContext());

      expect(store.update).toHaveBeenCalled();
      const updateArgs = (store.update as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      const updates = updateArgs[1] as { readonly collectiveMemory: CollectiveMemory };
      expect(updates.collectiveMemory.entries.length).toBeGreaterThanOrEqual(2);
    });

    test("LLM extraction failure does not break session cleanup", async () => {
      const modelCall = mock(async (): Promise<ModelResponse> => {
        throw new Error("LLM service unavailable");
      });
      const config = createConfig({ modelCall });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());

      const next = mock(async () => ({ output: "Some output" }));
      await middleware.wrapToolCall?.(
        createTurnContext(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );

      // Should not throw
      await middleware.onSessionEnd?.(createSessionContext());
    });

    test("resets session outputs after onSessionEnd", async () => {
      const modelCall = mock(
        async (_req: ModelRequest): Promise<ModelResponse> => ({
          content: "[]",
          model: "haiku",
        }),
      );
      const config = createConfig({ modelCall });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());

      const next = mock(async () => ({ output: "First session output" }));
      await middleware.wrapToolCall?.(
        createTurnContext(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );

      await middleware.onSessionEnd?.(createSessionContext());
      expect(modelCall).toHaveBeenCalledTimes(1);

      // Second session — no outputs accumulated
      modelCall.mockClear();
      await middleware.onSessionStart?.(createSessionContext());
      await middleware.onSessionEnd?.(createSessionContext());
      expect(modelCall).not.toHaveBeenCalled();
    });

    test("passes extractionModel and extractionMaxTokens to model call", async () => {
      const store = createMockForgeStore();
      const modelCall = mock(
        async (_req: ModelRequest): Promise<ModelResponse> => ({
          content: "[]",
          model: "haiku",
        }),
      );
      const config = createConfig({
        forgeStore: store,
        modelCall,
        extractionModel: "claude-haiku-4-5",
        extractionMaxTokens: 2048,
      });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());

      const next = mock(async () => ({ output: "Some output" }));
      await middleware.wrapToolCall?.(
        createTurnContext(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );

      await middleware.onSessionEnd?.(createSessionContext());

      const callArg = (modelCall.mock.calls[0] as unknown[])[0] as ModelRequest;
      expect(callArg.model).toBe("claude-haiku-4-5");
      expect(callArg.maxTokens).toBe(2048);
    });

    test("skips persistence when brick ID cannot be resolved", async () => {
      const store = createMockForgeStore();
      const modelCall = mock(
        async (_req: ModelRequest): Promise<ModelResponse> => ({
          content: JSON.stringify([{ content: "A learning", category: "gotcha" }]),
          model: "haiku",
        }),
      );
      const config = createConfig({
        forgeStore: store,
        modelCall,
        resolveBrickId: () => undefined,
      });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());

      const next = mock(async () => ({ output: "Some output" }));
      await middleware.wrapToolCall?.(createTurnContext(), { toolId: "task", input: {} }, next);

      (store.update as ReturnType<typeof mock>).mockClear();
      await middleware.onSessionEnd?.(createSessionContext());

      // modelCall should be called but store.update should not
      expect(modelCall).toHaveBeenCalledTimes(1);
      expect(store.update).not.toHaveBeenCalled();
    });

    test("both regex and LLM extraction coexist", async () => {
      const store = createMockForgeStore();
      const modelCall = mock(
        async (_req: ModelRequest): Promise<ModelResponse> => ({
          content: JSON.stringify([{ content: "LLM-extracted learning", category: "pattern" }]),
          model: "haiku",
        }),
      );
      const config = createConfig({ forgeStore: store, modelCall });
      const middleware = createCollectiveMemoryMiddleware(config);

      await middleware.onSessionStart?.(createSessionContext());

      // Output with both a marker (for regex) and general content (for LLM)
      const next = mock(async () => ({
        output: "[LEARNING:gotcha] Regex-extracted learning\nAlso some general insights here",
      }));
      await middleware.wrapToolCall?.(
        createTurnContext(),
        { toolId: "task", input: { agentName: "researcher" } },
        next,
      );

      // Regex extraction should have already persisted
      expect(store.update).toHaveBeenCalled();
      const regexCallCount = (store.update as ReturnType<typeof mock>).mock.calls.length;

      // Now LLM extraction on session end
      await middleware.onSessionEnd?.(createSessionContext());

      // Additional store.update call from LLM extraction
      expect((store.update as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(
        regexCallCount,
      );
    });
  });
});
