/**
 * Engine contract compliance tests for @koi/engine-claude.
 *
 * Verifies the Claude adapter satisfies all L0 contract invariants
 * using a mocked SDK.
 */

import { describe, expect, test } from "bun:test";
import type { ApprovalDecision, EngineEvent } from "@koi/core";
import { testEngineAdapter } from "@koi/test-utils";
import type { SdkFunctions, SdkInputMessage } from "../src/adapter.js";
import { createClaudeAdapter } from "../src/adapter.js";
import type { SdkMessage } from "../src/event-map.js";
import type { ClaudeAdapterConfig } from "../src/types.js";

function createContractSdk(): SdkFunctions {
  return {
    query: async function* (_params: {
      prompt: string | AsyncIterable<SdkInputMessage>;
    }): AsyncGenerator<SdkMessage> {
      yield { type: "system", subtype: "init", session_id: "contract-sess" };
      // Assistant with tool call
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me search." },
            { type: "tool_use", id: "call-1", name: "search", input: { q: "test" } },
          ],
        },
      };
      // User message with tool result (triggers tool_call_end + turn_end)
      yield {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "Search results..." }],
        },
      };
      // Final assistant response
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Here are the results." }],
        },
      };
      yield {
        type: "result",
        subtype: "success",
        result: "Here are the results.",
        session_id: "contract-sess",
        num_turns: 1,
        duration_ms: 100,
        usage: { input_tokens: 10, output_tokens: 20 },
      };
    },
  };
}

describe("@koi/engine-claude contract", () => {
  testEngineAdapter({
    createAdapter: () => createClaudeAdapter({}, createContractSdk()),
  });
});

// ---------------------------------------------------------------------------
// HITL contract scenario
// ---------------------------------------------------------------------------

describe("@koi/engine-claude HITL contract", () => {
  test("adapter with approvalHandler emits HITL events and saveHumanMessage works", async () => {
    let canUseToolFn:
      | ((toolName: string, input: Record<string, unknown>) => Promise<unknown>)
      | undefined;

    const hitlSdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        canUseToolFn = (params.options as Record<string, unknown>)
          ?.canUseTool as typeof canUseToolFn;

        yield { type: "system", subtype: "init", session_id: "hitl-sess" } as SdkMessage;

        // Simulate SDK calling canUseTool
        if (canUseToolFn !== undefined) {
          await canUseToolFn("search", { q: "test" });
        }

        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Approved and done." }] },
        } as SdkMessage;

        yield {
          type: "result",
          subtype: "success",
          result: "Done",
          session_id: "hitl-sess",
          num_turns: 1,
          duration_ms: 50,
          usage: { input_tokens: 5, output_tokens: 3 },
        } as SdkMessage;
      },
    };

    const config: ClaudeAdapterConfig = {
      approvalHandler: async (): Promise<ApprovalDecision> => ({ kind: "allow" }),
    };

    const adapter = createClaudeAdapter(config, hitlSdk);

    // Verify saveHumanMessage exists
    expect(typeof adapter.saveHumanMessage).toBe("function");

    const events: EngineEvent[] = [];
    for await (const event of adapter.stream({ kind: "text", text: "Search for something" })) {
      events.push(event);
    }

    // Should have custom events for HITL
    const customEvents = events.filter((e) => e.kind === "custom");
    expect(customEvents.length).toBeGreaterThanOrEqual(2); // request + response

    // Should have a done event
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();
  });
});
