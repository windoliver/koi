import { describe, expect, mock, test } from "bun:test";
import type {
  MemoryComponent,
  ModelHandler,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createExtractionMiddleware } from "./extraction-middleware.js";
import type { HotMemoryNotifier } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockMemory(): MemoryComponent & {
  readonly stored: Array<{
    content: string;
    category?: string | undefined;
    type?: string | undefined;
  }>;
} {
  const stored: Array<{
    content: string;
    category?: string | undefined;
    type?: string | undefined;
  }> = [];
  return {
    stored,
    async recall() {
      return [];
    },
    async store(content: string, options?: Parameters<MemoryComponent["store"]>[1]) {
      stored.push({ content, category: options?.category, type: options?.type });
    },
  };
}

function createMockModelCall(response: string): ModelHandler {
  return mock(async () => ({
    content: response,
    model: "test-model",
  }));
}

function createMockHotMemory(): HotMemoryNotifier & { readonly notifyCount: { value: number } } {
  const notifyCount = { value: 0 };
  return {
    notifyCount,
    notifyStoreOccurred() {
      notifyCount.value += 1;
    },
  };
}

function createSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: "sess-1" as never,
    runId: "run-1" as never,
    metadata: {},
    ...overrides,
  };
}

function createTurnCtx(): TurnContext {
  return {
    session: createSessionCtx(),
    turnIndex: 0,
    turnId: "turn-1" as never,
    messages: [],
    metadata: {},
  };
}

function spawnToolRequest(toolId: string = "Spawn"): ToolRequest {
  return {
    toolId,
    input: { agentName: "worker" },
  };
}

function toolResponse(output: string): ToolResponse {
  return { output };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createExtractionMiddleware", () => {
  describe("metadata", () => {
    test("has correct name and priority", () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      expect(mw.name).toBe("koi:extraction");
      expect(mw.priority).toBe(305);
    });

    test("describes capabilities", () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      const caps = mw.describeCapabilities(createTurnCtx());
      expect(caps).toBeDefined();
      expect(caps?.label).toBe("extraction");
    });
  });

  describe("session lifecycle", () => {
    test("initializes clean state on session start", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });

      // Start session
      await mw.onSessionStart?.(createSessionCtx());

      // No errors, state is clean
      expect(memory.stored).toHaveLength(0);
    });

    test("cleans up on session end even without model call", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });

      await mw.onSessionStart?.(createSessionCtx());
      await mw.onSessionEnd?.(createSessionCtx());

      // No stored memories since no model call configured
      expect(memory.stored).toHaveLength(0);
    });
  });

  describe("wrapToolCall — regex extraction", () => {
    test("extracts learnings from spawn tool output", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("[LEARNING:gotcha] Always check null"));

      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      // Wait for fire-and-forget persist
      await new Promise((r) => setTimeout(r, 10));

      expect(next).toHaveBeenCalledTimes(1);
      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.content).toBe("Always check null");
      expect(memory.stored[0]?.category).toBe("gotcha");
    });

    test("ignores non-spawn tools", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("[LEARNING:gotcha] Should be ignored"));

      await mw.wrapToolCall?.(createTurnCtx(), { toolId: "read_file", input: {} }, next);

      await new Promise((r) => setTimeout(r, 10));

      expect(next).toHaveBeenCalledTimes(1);
      expect(memory.stored).toHaveLength(0);
    });

    test("drops extracted learnings that contain secrets", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("[LEARNING:gotcha] password=SuperSecret12345678"));

      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      // Secret-containing candidate should be dropped
      expect(memory.stored).toHaveLength(0);
    });

    test("passes through response unchanged", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const expected = toolResponse("some output");
      const next = mock(async () => expected);

      const result = await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      expect(result).toBe(expected);
    });

    test("notifies hot-memory after successful store", async () => {
      const memory = createMockMemory();
      const hotMemory = createMockHotMemory();
      const mw = createExtractionMiddleware({ memory, hotMemory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("[LEARNING:pattern] Use DI for testing"));

      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(hotMemory.notifyCount.value).toBe(1);
    });
  });

  describe("wrapToolCall — output accumulation", () => {
    test("accumulates spawn outputs for LLM extraction", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({ memory, modelCall });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("some task output"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      // Trigger LLM extraction via session end
      await mw.onSessionEnd?.(createSessionCtx());

      expect(modelCall).toHaveBeenCalledTimes(1);
    });

    test("caps accumulated outputs at maxSessionOutputs", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({
        memory,
        modelCall,
        maxSessionOutputs: 2,
      });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("output"));
      for (let i = 0; i < 5; i++) {
        await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      }

      await mw.onSessionEnd?.(createSessionCtx());

      // Model call should have been made with at most 2 outputs
      expect(modelCall).toHaveBeenCalledTimes(1);
    });
  });

  describe("onSessionEnd — LLM extraction", () => {
    test("runs LLM extraction and stores results", async () => {
      const memory = createMockMemory();
      const modelResponse = JSON.stringify([
        { content: "Always validate input", category: "heuristic" },
      ]);
      const modelCall = createMockModelCall(modelResponse);
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());

      // Accumulate an output
      const next = mock(async () => toolResponse("did some work"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      // Trigger extraction
      await mw.onSessionEnd?.(createSessionCtx());

      expect(modelCall).toHaveBeenCalledTimes(1);
      expect(memory.stored.some((s) => s.content === "Always validate input")).toBe(true);
    });

    test("skips LLM extraction when no outputs accumulated", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());
      await mw.onSessionEnd?.(createSessionCtx());

      expect(modelCall).not.toHaveBeenCalled();
    });

    test("swallows LLM extraction errors", async () => {
      const memory = createMockMemory();
      const modelCall = mock(async () => {
        throw new Error("model failed");
      }) as unknown as ModelHandler;
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("some output"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);

      // Should not throw
      await mw.onSessionEnd?.(createSessionCtx());
    });

    test("resets session state after session end", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(async () => toolResponse("output"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await mw.onSessionEnd?.(createSessionCtx());

      // Second session end should not trigger model call (outputs were drained)
      await mw.onSessionEnd?.(createSessionCtx());
      expect(modelCall).toHaveBeenCalledTimes(1);
    });

    test("excludes preference learnings (user type) from shared store — no user-scoped namespace yet", async () => {
      const memory = createMockMemory();
      const modelResponse = JSON.stringify([
        { content: "User prefers tabs", category: "preference" },
        { content: "Always validate input", category: "heuristic" },
      ]);
      const modelCall = createMockModelCall(modelResponse);
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(async () => toolResponse("did work"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await mw.onSessionEnd?.(createSessionCtx());

      // Preferences are typed "user" (correct privacy class) but not persisted:
      // the file-backed store has no per-user namespace isolation and recall
      // injects into every session from the same directory. The skip is explicit
      // (console.warn) rather than silent. Wire user-scoped storage to enable.
      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.content).toBe("Always validate input");
    });
  });

  describe("session isolation", () => {
    test("interleaved sessions do not share output buffers", async () => {
      const memory = createMockMemory();
      const modelCall = createMockModelCall("[]");
      const mw = createExtractionMiddleware({ memory, modelCall });

      const sessA = createSessionCtx({ sessionId: "sess-a" as never });
      const sessB = createSessionCtx({ sessionId: "sess-b" as never });
      const turnA: TurnContext = {
        session: sessA,
        turnIndex: 0,
        turnId: "turn-a" as never,
        messages: [],
        metadata: {},
      };
      const _turnB: TurnContext = {
        session: sessB,
        turnIndex: 0,
        turnId: "turn-b" as never,
        messages: [],
        metadata: {},
      };

      await mw.onSessionStart?.(sessA);
      await mw.onSessionStart?.(sessB);

      // Session A accumulates an output
      const nextA = mock(async () => toolResponse("output from A"));
      await mw.wrapToolCall?.(turnA, spawnToolRequest(), nextA);

      // Session B ends — should NOT trigger LLM call (B has no outputs)
      await mw.onSessionEnd?.(sessB);
      expect(modelCall).not.toHaveBeenCalled();

      // Session A ends — should trigger LLM call (A has an output)
      await mw.onSessionEnd?.(sessA);
      expect(modelCall).toHaveBeenCalledTimes(1);
    });
  });

  describe("memoryType propagation (issue #1966)", () => {
    test("stores pattern category with type=feedback (regression #1964: was reference)", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () =>
        toolResponse("[LEARNING:pattern] Always validate input at boundaries"),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.type).toBe("feedback");
    });

    test("stores heuristic category with type=feedback (regression #1964: was reference)", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () =>
        toolResponse("[LEARNING:heuristic] connection pooling improves throughput"),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.type).toBe("feedback");
    });

    test("stores context category with type=project", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse("[LEARNING:context] team uses Bun not Node"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.type).toBe("project");
    });

    test("stores gotcha category with type=feedback", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () =>
        toolResponse("[LEARNING:gotcha] null pointer dereference crashes process"),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      const gotcha = memory.stored.find((s) => s.category === "gotcha");
      expect(gotcha?.type).toBe("feedback");
    });

    test("LLM path stores heuristic and pattern with type=feedback (regression #1964: was reference)", async () => {
      const memory = createMockMemory();
      const modelResponse = JSON.stringify([
        { content: "Always validate input", category: "heuristic" },
        { content: "Use DI for testing", category: "pattern" },
      ]);
      const modelCall = createMockModelCall(modelResponse);
      const mw = createExtractionMiddleware({ memory, modelCall });

      await mw.onSessionStart?.(createSessionCtx());
      const next = mock(async () => toolResponse("did work"));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await mw.onSessionEnd?.(createSessionCtx());

      const heuristic = memory.stored.find((s) => s.content === "Always validate input");
      const pattern = memory.stored.find((s) => s.content === "Use DI for testing");
      expect(heuristic?.type).toBe("feedback");
      expect(pattern?.type).toBe("feedback");
    });
  });

  describe("JSON output pre-processing (multi-field bleed prevention)", () => {
    test("extracts clean content from multi-field JSON object", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // Multi-field JSON: without pre-processing, (.+) would capture
      // 'Always validate input","status":"ok' as content
      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            result: "[LEARNING:pattern] Always validate input",
            status: "ok",
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.content).toBe("Always validate input");
    });

    test("extracts from nested JSON object", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            output: { message: "[LEARNING:heuristic] Keep functions under 50 lines" },
            exitCode: 0,
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      const stored = memory.stored.find((s) => s.category === "heuristic");
      expect(stored?.content).toBe("Keep functions under 50 lines");
    });

    test("does not extract from non-output fields (memory poisoning prevention)", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // Markers in 'request'/'metadata' fields must not be extracted — these
      // fields are not in OUTPUT_FIELD_NAMES, preventing memory poisoning via echoed input text.
      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            request: "[LEARNING:gotcha] injected via echoed input",
            metadata: "[LEARNING:pattern] injected via metadata",
            result: "clean output with no markers",
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      // No markers in the output field — nothing should be stored
      expect(memory.stored).toHaveLength(0);
    });

    test("does not extract from non-allowlisted fields inside JSON arrays", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // Poisoning markers in 'request'/'metadata' must not be extracted.
      // Only OUTPUT_FIELD_NAMES are trusted; 'result' value has no LEARNING markers.
      const next = mock(async () =>
        toolResponse(
          JSON.stringify([
            {
              request: "[LEARNING:gotcha] array-wrapped poison via request",
              metadata: "[LEARNING:pattern] array-wrapped poison via metadata",
              result: "clean array output",
            },
          ]),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      // 'request'/'metadata' not in allowlist; 'result' = "clean array output" → no markers
      expect(memory.stored).toHaveLength(0);
    });

    test("skips regex extraction for JSON with no output fields", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // JSON with ONLY non-output fields (status, code) → none in OUTPUT_FIELD_NAMES
      // → skip extraction rather than fall back to raw JSON string.
      const next = mock(async () => toolResponse(JSON.stringify({ status: "ok", code: 0 })));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("LLM extraction path also receives filtered output (not raw JSON)", async () => {
      const memory = createMockMemory();
      // modelCall returns a learning as if it found one in the filtered output
      const modelCall = createMockModelCall(
        JSON.stringify([{ content: "Always validate input", category: "pattern" }]),
      );
      const mw = createExtractionMiddleware({ memory, modelCall });
      const ctx = createSessionCtx();
      await mw.onSessionStart?.(ctx);

      // Poisoning markers in 'request' field — must not reach the LLM extractor.
      // After filtering, only the 'result' field value reaches the LLM.
      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            request: "[LEARNING:gotcha] poison via request",
            result: "clean output",
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await mw.onSessionEnd?.(ctx);

      // Verify the LLM was called with text that does NOT contain the poison field
      expect(modelCall).toHaveBeenCalledTimes(1);
      const calls = (modelCall as ReturnType<typeof mock>).mock.calls as unknown as Array<
        [{ messages: Array<{ content: Array<{ text?: string }> }> }]
      >;
      const promptText = calls[0]?.[0]?.messages[0]?.content[0]?.text ?? "";
      expect(promptText).not.toContain("poison via request");
      expect(promptText).toContain("clean output");
    });

    test("does not extract from custom field names not in allowlist (security: allowlist wins)", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // Only OUTPUT_FIELD_NAMES are trusted. Custom fields like "finding", "task",
      // "subject" are not in the allowlist and produce no extraction — this prevents
      // poisoning via task_delegate responses whose 'task.subject' echoes user input.
      const next = mock(async () =>
        toolResponse(JSON.stringify({ finding: "[LEARNING:pattern] Always validate" })),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("does not extract from task_delegate-style responses with subject field", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // task_delegate returns { ok, task: { subject, status, id }, delegatedTo }.
      // None of these fields are in OUTPUT_FIELD_NAMES, so injection via task
      // subject echoing user-controlled text is blocked.
      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            ok: true,
            task: { subject: "[LEARNING:gotcha] injected via task subject", status: "pending" },
            delegatedTo: "agent-1",
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("does not extract from non-output fields nested inside allowed envelope", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // Allowlist applies recursively: nested 'request' inside 'result' is blocked,
      // but 'message' (in allowlist) is extracted.
      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            result: {
              message: "[LEARNING:pattern] clean nested learning",
              request: "[LEARNING:gotcha] nested poison via request",
            },
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      // Only 'message' (in allowlist) should be extracted, not 'request'
      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.content).toBe("clean nested learning");
    });

    test("whitespace-prefixed JSON is still parsed and filtered", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // Leading newline/whitespace before JSON must not bypass the field filter.
      const poisonedJson = `\n  ${JSON.stringify({
        request: "[LEARNING:gotcha] whitespace-bypass poison",
        result: "clean whitespace-prefixed output",
      })}`;
      const next = mock(async () => toolResponse(poisonedJson));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      // No markers in 'result' field — nothing extracted
      expect(memory.stored).toHaveLength(0);
    });

    test("top-level plain-string array does not bypass field filter (issue #1966 regression)", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // A spawn result that is a top-level JSON array of plain strings must NOT
      // have its strings extracted — the allowlist requires strings to be rooted
      // under an allowed field name (result, output, text, etc.).
      // Previously, `extractOutputStrings` returned all strings unconditionally,
      // letting injected LEARNING markers slip through.
      const next = mock(async () =>
        toolResponse(JSON.stringify(["[LEARNING:gotcha] injected via top-level array", "clean"])),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("top-level array of objects with disallowed-only keys produces no extraction", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // Array of objects where every key is outside the allowlist — nothing extracted.
      const next = mock(async () =>
        toolResponse(
          JSON.stringify([
            { request: "[LEARNING:gotcha] poison in request", metadata: "some metadata" },
          ]),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("does not extract from top-level command-result envelope (tool-only spawn child, stdout is subprocess output)", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // Tool-only spawn children end on a tool call with no model-authored text.
      // createTextCollector serializes the last tool_result as JSON, producing
      // '{"stdout":"...","exitCode":0}' as ToolResponse.output. stdout is raw
      // subprocess output — arbitrary text the shell wrote, which may include
      // echoed user input or injected markers. Skip silently; no extraction.
      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            stdout: "[LEARNING:gotcha] Always check return codes",
            stderr: "",
            exitCode: 0,
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("does not extract stdout from command-result envelope nested inside output field (subprocess output untrusted)", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // stdout is raw subprocess output — arbitrary text the spawned process wrote to
      // its stdout, which may include echoed user input or injected markers.
      // The top-level spawn path handles command-result envelopes via the IIFE in
      // wrapToolCall; the nested JSON re-parse inside extractOutputStrings must NOT
      // grant stdout a special trust escalation.
      const bashResult = JSON.stringify({
        stdout: "[LEARNING:gotcha] Always check return codes",
        stderr: "",
        exitCode: 0,
      });
      const next = mock(async () => toolResponse(JSON.stringify({ output: bashResult })));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("does not extract from any field in output-nested command-result envelope (all untrusted subprocess output)", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // A command-result envelope nested inside an `output` field is treated as opaque
      // JSON: neither stdout nor request nor any other field is extracted. stdout is
      // raw subprocess output (untrusted); request is echoed user/task text (untrusted).
      // The allowlist traversal finds no OUTPUT_FIELD_NAMES keys and produces no strings.
      const poisonedResult = JSON.stringify({
        request: "[LEARNING:inject] poisoned task subject",
        stdout: "[LEARNING:gotcha] Valid return code check",
        exitCode: 0,
      });
      const next = mock(async () => toolResponse(JSON.stringify({ output: poisonedResult })));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("does not treat stdout-only JSON as command-result (exitCode required)", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // isCommandResultEnvelope requires BOTH stdout:string AND exitCode:number.
      // An object with only stdout does not trigger the command-result path.
      const stdoutOnlyResult = JSON.stringify({ stdout: "[LEARNING:gotcha] Avoid X" });
      const next = mock(async () => toolResponse(JSON.stringify({ output: stdoutOnlyResult })));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("does not extract from exitCode or status fields", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () => toolResponse(JSON.stringify({ exitCode: 1, status: "error" })));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("does not extract poisoned markers from JSON-encoded string inside allowed output field", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // An allowed `output` field contains a stringified JSON object whose
      // `request` key echoes poisoned content. The nested JSON must be re-filtered
      // through the allowlist — `request` is not in OUTPUT_FIELD_NAMES.
      const inner = JSON.stringify({ request: "[LEARNING:gotcha] smuggled via nested JSON" });
      const next = mock(async () => toolResponse(JSON.stringify({ output: inner })));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(0);
    });

    test("extracts from allowed field inside JSON-encoded string when field is trusted", async () => {
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      // Allowed `output` field contains JSON with an allowed `result` key — that
      // inner `result` should be extracted (double-envelope, both fields trusted).
      const inner = JSON.stringify({ result: "[LEARNING:pattern] Use builder pattern" });
      const next = mock(async () => toolResponse(JSON.stringify({ output: inner })));
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(1);
      expect(memory.stored[0]?.content).toBe("Use builder pattern");
    });
  });

  describe("regression fixtures — S14 Q97 and Q98 (issue #1966)", () => {
    // Exact reproduction scenarios from the issue. These are the inputs that
    // triggered all three bugs: wrong type, category-as-description, JSON artifact.

    test("S14 Q97: marker extraction from structured spawn output — clean content and correct type", async () => {
      // Spawn tool returns JSON where a child agent echoed the LEARNING marker
      // inside the result field. Before the fix: type=feedback (hardcoded for all),
      // content="Always validate input at boundaries\"}" (JSON artifact).
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            result: "[LEARNING:pattern] Always validate input at boundaries",
            status: "done",
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(1);
      const stored = memory.stored[0];
      expect(stored?.content).toBe("Always validate input at boundaries");
      expect(stored?.category).toBe("pattern");
      expect(stored?.type).toBe("feedback");
    });

    test("S14 Q98: heuristic marker extraction from structured spawn output — clean content and correct type", async () => {
      // Spawn tool returns JSON where a child agent echoed the LEARNING marker
      // inside the output field. Before the fix: type=feedback (hardcoded for all),
      // content="connection pooling improves throughput\"}" (JSON artifact).
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            output: "[LEARNING:heuristic] connection pooling improves throughput",
            status: "done",
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(1);
      const stored = memory.stored[0];
      expect(stored?.content).toBe("connection pooling improves throughput");
      expect(stored?.category).toBe("heuristic");
      expect(stored?.type).toBe("feedback");
    });

    test("S14 Q98b: heuristic regex extraction from structured spawn output — keyword text without marker", async () => {
      // Covers the extractHeuristics path (no [LEARNING:...] marker): a spawn tool
      // returns JSON where the trusted `output` field contains heuristic keyword text.
      // This ensures a regression in JSON pre-processing would also break heuristic
      // extraction, not only marker extraction.
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const next = mock(async () =>
        toolResponse(
          JSON.stringify({
            output: "learned that connection pooling improves throughput",
            status: "done",
          }),
        ),
      );
      await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(1);
      const stored = memory.stored[0];
      expect(stored?.content).toBe("connection pooling improves throughput");
      expect(stored?.category).toBe("heuristic");
      expect(stored?.type).toBe("feedback");
    });
  });

  describe("category mapping invariant — all 6 categories through adapter boundary (issue #1966)", () => {
    // Single invariant: every CollectiveMemoryCategory maps to the correct MemoryType
    // end-to-end through the full middleware pipeline (raw tool output → store call).
    // Catches regressions where the adapter or persistCandidates re-introduces a
    // hardcoded default (e.g. type: "feedback" for all) after mapCategoryToMemoryType runs.
    //
    // Known limitation: salience scoring weights by `type` only (feedback=1.2,
    // reference=0.8). Auto-extracted heuristic/pattern entries share the same type
    // as human-validated gotcha/correction — the `category` field is the only
    // persisted boundary until confidence/source metadata is threaded through the
    // schema and scoring pipeline.

    const cases: ReadonlyArray<{
      readonly marker: string;
      readonly category: string;
      readonly expectedType: string;
      readonly expectedStored: boolean;
    }> = [
      { marker: "gotcha", category: "gotcha", expectedType: "feedback", expectedStored: true },
      {
        marker: "correction",
        category: "correction",
        expectedType: "feedback",
        expectedStored: true,
      },
      {
        marker: "heuristic",
        category: "heuristic",
        expectedType: "feedback",
        expectedStored: true,
      },
      { marker: "pattern", category: "pattern", expectedType: "feedback", expectedStored: true },
      { marker: "preference", category: "preference", expectedType: "user", expectedStored: false },
      { marker: "context", category: "context", expectedType: "project", expectedStored: true },
    ];

    test("auto-extracted heuristic/pattern remain distinguishable from validated gotcha/correction via category field", async () => {
      // type=feedback is shared across all four categories. The category field is
      // the persisted boundary: downstream consumers (sync filters, future salience
      // paths) can filter auto-extracted entries (heuristic/pattern) from
      // human-validated ones (gotcha/correction) using this field.
      const memory = createMockMemory();
      const mw = createExtractionMiddleware({ memory });
      await mw.onSessionStart?.(createSessionCtx());

      const outputs = [
        "[LEARNING:gotcha] null pointer crash",
        "[LEARNING:correction] API returns 204 not 200",
        "[LEARNING:heuristic] connection pooling improves throughput",
        "[LEARNING:pattern] always validate at boundaries",
      ];
      for (const output of outputs) {
        const next = mock(async () => toolResponse(output));
        await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
      }
      await new Promise((r) => setTimeout(r, 10));

      expect(memory.stored).toHaveLength(4);
      const byCategory = Object.fromEntries(memory.stored.map((s) => [s.category, s.type]));
      // All four are feedback type
      expect(byCategory["gotcha"]).toBe("feedback");
      expect(byCategory["correction"]).toBe("feedback");
      expect(byCategory["heuristic"]).toBe("feedback");
      expect(byCategory["pattern"]).toBe("feedback");
      // But category field distinguishes validated from auto-extracted
      const validated = memory.stored.filter(
        (s) => s.category === "gotcha" || s.category === "correction",
      );
      const autoExtracted = memory.stored.filter(
        (s) => s.category === "heuristic" || s.category === "pattern",
      );
      expect(validated).toHaveLength(2);
      expect(autoExtracted).toHaveLength(2);
    });

    for (const { marker, category, expectedType, expectedStored } of cases) {
      test(`[LEARNING:${marker}] → type=${expectedType}, stored=${expectedStored}`, async () => {
        const memory = createMockMemory();
        const mw = createExtractionMiddleware({ memory });
        await mw.onSessionStart?.(createSessionCtx());

        const content = `test learning for category ${marker}`;
        const next = mock(async () => toolResponse(`[LEARNING:${marker}] ${content}`));
        await mw.wrapToolCall?.(createTurnCtx(), spawnToolRequest(), next);
        await new Promise((r) => setTimeout(r, 10));

        if (expectedStored) {
          expect(memory.stored).toHaveLength(1);
          expect(memory.stored[0]?.category).toBe(category);
          expect(memory.stored[0]?.type).toBe(expectedType);
          expect(memory.stored[0]?.content).toBe(content);
        } else {
          // preference → user type, skipped by persistCandidates (no namespace-isolated store)
          expect(memory.stored).toHaveLength(0);
        }
      });
    }
  });
});
