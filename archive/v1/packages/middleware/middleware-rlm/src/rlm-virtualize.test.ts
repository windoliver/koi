import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage, ModelRequest, ToolHandler, ToolRequest } from "@koi/core";
import type { RlmAuditEvent } from "./rlm-virtualize.js";
import { createRlmVirtualizeMiddleware } from "./rlm-virtualize.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMessage(text: string, senderId: string = "user"): InboundMessage {
  return {
    content: [{ kind: "text" as const, text }],
    senderId,
    timestamp: Date.now(),
  };
}

function createModelHandler(
  response: string = "ok",
): (req: ModelRequest) => Promise<{ readonly content: string; readonly model: string }> {
  return mock(async () => ({ content: response, model: "test" }));
}

function createToolHandler(output: unknown = "tool result"): ToolHandler {
  return mock(async () => ({ output }));
}

const smallText = "This is a small message.";
const largeText = "x".repeat(100_000); // ~25K tokens

const testTempDir = join(tmpdir(), `rlm-test-${String(Date.now())}`);

const minimalCtx = {
  session: { sessionId: "test-session" },
  turnIndex: 0,
  turnId: "turn-0",
  messages: [],
  metadata: {},
} as unknown as Parameters<
  NonNullable<ReturnType<typeof createRlmVirtualizeMiddleware>["wrapModelCall"]>
>[0];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(testTempDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testTempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRlmVirtualizeMiddleware", () => {
  test("small messages pass through unchanged", async () => {
    const mw = createRlmVirtualizeMiddleware({ tempDir: testTempDir });
    const next = createModelHandler();
    const request: ModelRequest = { messages: [createMessage(smallText)] };

    await mw.wrapModelCall!(minimalCtx, request, next);

    const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
    const firstBlock = calledWith.messages[0]?.content[0];
    expect(firstBlock?.kind).toBe("text");
    if (firstBlock?.kind === "text") {
      expect(firstBlock.text).toBe(smallText);
    }
  });

  test("large text block is virtualized with stub", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const next = createModelHandler();

    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(largeText)] }, next);

    const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
    const firstBlock = calledWith.messages[0]?.content[0];
    expect(firstBlock?.kind).toBe("text");
    if (firstBlock?.kind === "text") {
      expect(firstBlock.text).toContain("[Virtualized input v0]");
      expect(firstBlock.text).toContain("File:");
      expect(firstBlock.text).not.toBe(largeText);
    }
  });

  test("temp file written to disk", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const next = createModelHandler();

    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(largeText)] }, next);

    const filePath = join(testTempDir, "test-session", "v0.txt");
    expect(existsSync(filePath)).toBe(true);
  });

  test("system messages are NOT virtualized", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const next = createModelHandler();

    await mw.wrapModelCall!(
      minimalCtx,
      { messages: [createMessage(largeText, "system:plan")] },
      next,
    );

    const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
    const firstBlock = calledWith.messages[0]?.content[0];
    if (firstBlock?.kind === "text") {
      expect(firstBlock.text).toBe(largeText);
    }
  });

  test("RLM tools injected when content virtualized", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const next = createModelHandler();

    await mw.wrapModelCall!(
      minimalCtx,
      {
        messages: [createMessage(largeText)],
        tools: [{ name: "existing_tool", description: "test", inputSchema: {} }],
      },
      next,
    );

    const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
    const toolNames = calledWith.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("existing_tool");
    expect(toolNames).toContain("rlm_examine");
    expect(toolNames).toContain("rlm_chunk");
    expect(toolNames).toContain("rlm_input_info");
    expect(toolNames).not.toContain("rlm_llm_query");
  });

  test("tools NOT injected when no content virtualized", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const next = createModelHandler();

    await mw.wrapModelCall!(
      minimalCtx,
      {
        messages: [createMessage(smallText)],
        tools: [{ name: "existing_tool", description: "test", inputSchema: {} }],
      },
      next,
    );

    const calledWith = (next as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
    const toolNames = calledWith.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toEqual(["existing_tool"]);
  });

  test("rlm_examine dispatches to InputStore", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const modelNext = createModelHandler();

    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(largeText)] }, modelNext);

    const toolNext = createToolHandler();
    const response = await mw.wrapToolCall!(
      minimalCtx,
      {
        toolId: "rlm_examine",
        input: { offset: 0, length: 10 },
      } as unknown as ToolRequest,
      toolNext,
    );

    expect(response.output).toBe("x".repeat(10));
    expect(toolNext).not.toHaveBeenCalled();
  });

  test("rlm_input_info returns metadata", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const modelNext = createModelHandler();

    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(largeText)] }, modelNext);

    const toolNext = createToolHandler();
    const response = await mw.wrapToolCall!(
      minimalCtx,
      {
        toolId: "rlm_input_info",
        input: {},
      } as unknown as ToolRequest,
      toolNext,
    );

    const meta = response.output as Record<string, unknown>;
    expect(meta.format).toBe("plaintext");
    expect(meta.sizeBytes).toBeGreaterThan(0);
  });

  test("large tool output auto-virtualized", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const modelNext = createModelHandler();

    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(smallText)] }, modelNext);

    const toolNext = createToolHandler(largeText);
    const response = await mw.wrapToolCall!(
      minimalCtx,
      {
        toolId: "some_other_tool",
        input: {},
      } as unknown as ToolRequest,
      toolNext,
    );

    const output = response.output as string;
    expect(output).toContain("[Virtualized input");
    expect(output).not.toBe(largeText);
  });

  test("multiple virtualized stores coexist", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const modelNext = createModelHandler();

    const text1 = "a".repeat(100_000);
    const text2 = "b".repeat(100_000);

    await mw.wrapModelCall!(
      minimalCtx,
      {
        messages: [createMessage(text1), createMessage(text2)],
      },
      modelNext,
    );

    // Examine v0 — should return "a"s
    const toolNext = createToolHandler();
    const r0 = await mw.wrapToolCall!(
      minimalCtx,
      {
        toolId: "rlm_examine",
        input: { offset: 0, length: 5, storeId: "v0" },
      } as unknown as ToolRequest,
      toolNext,
    );
    expect(r0.output).toBe("aaaaa");

    // Examine v1 — should return "b"s
    const r1 = await mw.wrapToolCall!(
      minimalCtx,
      {
        toolId: "rlm_examine",
        input: { offset: 0, length: 5, storeId: "v1" },
      } as unknown as ToolRequest,
      toolNext,
    );
    expect(r1.output).toBe("bbbbb");
  });

  test("audit events emitted on virtualization", async () => {
    const events: RlmAuditEvent[] = [];
    const mw = createRlmVirtualizeMiddleware({
      virtualizeThreshold: 1_000,
      tempDir: testTempDir,
      onAudit: (e) => events.push(e),
    });
    const next = createModelHandler();

    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(largeText)] }, next);

    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("virtualized");
    if (events[0]?.kind === "virtualized") {
      expect(events[0].virtualId).toBe("v0");
      expect(events[0].source).toBe("message:user");
      expect(events[0].sizeBytes).toBeGreaterThan(0);
      expect(events[0].filePath).toContain("v0.txt");
    }
  });

  test("audit event on tool output virtualization", async () => {
    const events: RlmAuditEvent[] = [];
    const mw = createRlmVirtualizeMiddleware({
      virtualizeThreshold: 1_000,
      tempDir: testTempDir,
      onAudit: (e) => events.push(e),
    });
    const modelNext = createModelHandler();
    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(smallText)] }, modelNext);

    const toolNext = createToolHandler(largeText);
    await mw.wrapToolCall!(
      minimalCtx,
      {
        toolId: "browse",
        input: {},
      } as unknown as ToolRequest,
      toolNext,
    );

    const virtualized = events.filter((e) => e.kind === "virtualized");
    expect(virtualized.length).toBe(1);
    if (virtualized[0]?.kind === "virtualized") {
      expect(virtualized[0].source).toBe("tool_output:browse");
    }
  });

  test("rehydrates from temp file on session resume", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const modelNext = createModelHandler();

    // Session 1: virtualize content
    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(largeText)] }, modelNext);

    // Get the stub that was created
    const call1 = (modelNext as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
    const stubText = (call1.messages[0]?.content[0] as { readonly text: string }).text;

    // Clear session state (simulates session end + restart)
    await mw.onSessionEnd!({ sessionId: "test-session" } as unknown as Parameters<
      NonNullable<typeof mw.onSessionEnd>
    >[0]);

    // Session 2: stub is in history, temp file still on disk
    const modelNext2 = createModelHandler();
    await mw.wrapModelCall!(
      minimalCtx,
      {
        messages: [
          {
            content: [{ kind: "text" as const, text: stubText }],
            senderId: "user",
            timestamp: Date.now(),
          },
        ],
      },
      modelNext2,
    );

    // Tools should be injected (store was rehydrated)
    const call2 = (modelNext2 as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
    const toolNames = call2.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("rlm_examine");

    // rlm_examine should work (store rehydrated from file)
    const toolNext = createToolHandler();
    const response = await mw.wrapToolCall!(
      minimalCtx,
      {
        toolId: "rlm_examine",
        input: { offset: 0, length: 5 },
      } as unknown as ToolRequest,
      toolNext,
    );
    expect(response.output).toBe("xxxxx");
  });

  test("non-RLM tool calls pass through", async () => {
    const mw = createRlmVirtualizeMiddleware({ virtualizeThreshold: 1_000, tempDir: testTempDir });
    const modelNext = createModelHandler();
    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(smallText)] }, modelNext);

    const toolNext = createToolHandler("normal result");
    const response = await mw.wrapToolCall!(
      minimalCtx,
      {
        toolId: "some_tool",
        input: { foo: "bar" },
      } as unknown as ToolRequest,
      toolNext,
    );

    expect(response.output).toBe("normal result");
    expect(toolNext).toHaveBeenCalled();
  });

  test("existing stubs are not re-virtualized", async () => {
    const events: RlmAuditEvent[] = [];
    const mw = createRlmVirtualizeMiddleware({
      virtualizeThreshold: 1_000,
      tempDir: testTempDir,
      onAudit: (e) => events.push(e),
    });
    const modelNext = createModelHandler();

    // First call: virtualize
    await mw.wrapModelCall!(minimalCtx, { messages: [createMessage(largeText)] }, modelNext);
    expect(events.filter((e) => e.kind === "virtualized").length).toBe(1);

    // Get stub
    const call1 = (modelNext as ReturnType<typeof mock>).mock.calls[0]?.[0] as ModelRequest;
    const stubText = (call1.messages[0]?.content[0] as { readonly text: string }).text;

    // Second call with stub in history — should NOT re-virtualize
    const modelNext2 = createModelHandler();
    await mw.wrapModelCall!(
      minimalCtx,
      {
        messages: [
          {
            content: [{ kind: "text" as const, text: stubText }],
            senderId: "user",
            timestamp: Date.now(),
          },
        ],
      },
      modelNext2,
    );

    // Still only 1 virtualized event (+ 1 rehydrated)
    expect(events.filter((e) => e.kind === "virtualized").length).toBe(1);
  });
});
