/**
 * Engine contract compliance tests for @koi/engine-claude.
 *
 * Verifies the Claude adapter satisfies all L0 contract invariants
 * using a mocked SDK.
 */

import { describe } from "bun:test";
import { testEngineAdapter } from "@koi/test-utils";
import type { SdkFunctions } from "../src/adapter.js";
import { createClaudeAdapter } from "../src/adapter.js";
import type { SdkMessage } from "../src/event-map.js";

function createContractSdk(): SdkFunctions {
  return {
    query: async function* (_params: { prompt: string }): AsyncGenerator<SdkMessage> {
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
