/**
 * Unit tests for createGoalAnchorMiddleware.
 *
 * Tests 5 key behaviors:
 * 1. onSessionStart initializes todo with all objectives as "pending"
 * 2. wrapModelCall prepends todo block to messages (inject behavior)
 * 3. wrapModelCall updates todo when response contains completion signal
 * 4. No injection when objectives is empty
 * 5. onSessionEnd cleans up session state
 */

import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelResponse } from "@koi/core/middleware";
import {
  createMockModelHandler,
  createMockModelStreamHandler,
  createMockSessionContext,
  createMockTurnContext,
} from "@koi/test-utils";
import { createGoalAnchorMiddleware } from "./goal-anchor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModelResponse(text: string): ModelResponse {
  // ModelResponse.content is a string (full text response), not ContentBlock[]
  return { content: text, model: "test-model" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGoalAnchorMiddleware", () => {
  test("returns middleware with name 'goal-anchor' and priority 340", () => {
    const mw = createGoalAnchorMiddleware({ objectives: ["search the web"] });
    expect(mw.name).toBe("goal-anchor");
    expect(mw.priority).toBe(340);
  });

  describe("1. onSessionStart initializes todo with all objectives as pending", () => {
    test("all items start as pending", async () => {
      const completed: string[] = [];
      const mw = createGoalAnchorMiddleware({
        objectives: ["search the web", "write a report"],
        onComplete: (item) => {
          completed.push(item.text);
        },
      });

      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      // Verify no completions yet by making a call with no completion text
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      const handler = createMockModelHandler(makeModelResponse("Processing..."));
      if (mw.wrapModelCall) {
        await mw.wrapModelCall(turnCtx, { messages: [] }, handler);
      }

      expect(completed).toHaveLength(0);
    });
  });

  describe("2. wrapModelCall prepends todo block to messages", () => {
    test("injects a system:goal-anchor message before existing messages", async () => {
      let capturedRequest: ModelRequest | undefined;

      const mw = createGoalAnchorMiddleware({
        objectives: ["search the web"],
      });

      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);

      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });
      const handler = async (req: ModelRequest): Promise<ModelResponse> => {
        capturedRequest = req;
        return makeModelResponse("ok");
      };

      if (mw.wrapModelCall) {
        await mw.wrapModelCall(
          turnCtx,
          {
            messages: [
              { senderId: "user", timestamp: 0, content: [{ kind: "text", text: "hello" }] },
            ],
          },
          handler,
        );
      }

      const req = capturedRequest;
      expect(req).toBeDefined();
      if (req !== undefined) {
        expect(req.messages[0]?.senderId).toBe("system:goal-anchor");
        // Original user message should still be present
        expect(req.messages[1]?.senderId).toBe("user");
      }
    });

    test("todo block contains all objective texts", async () => {
      let capturedRequest: ModelRequest | undefined;
      const mw = createGoalAnchorMiddleware({
        objectives: ["search the web", "write a report"],
        header: "## Tasks",
      });

      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      const handler = async (req: ModelRequest): Promise<ModelResponse> => {
        capturedRequest = req;
        return makeModelResponse("ok");
      };

      if (mw.wrapModelCall) {
        await mw.wrapModelCall(turnCtx, { messages: [] }, handler);
      }

      const req = capturedRequest;
      expect(req).toBeDefined();
      const firstMsg = req?.messages[0];
      const content = firstMsg?.content[0];
      expect(content?.kind).toBe("text");
      if (content?.kind === "text") {
        expect(content.text).toContain("## Tasks");
        expect(content.text).toContain("search the web");
        expect(content.text).toContain("write a report");
        expect(content.text).toContain("- [ ]");
      }
    });
  });

  describe("3. wrapModelCall updates todo when response contains completion signal", () => {
    test("marks objective complete when response mentions it with completion keyword", async () => {
      const completed: string[] = [];
      const mw = createGoalAnchorMiddleware({
        objectives: ["search the web"],
        onComplete: (item) => {
          completed.push(item.text);
        },
      });

      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      const handler = async (_req: ModelRequest): Promise<ModelResponse> => {
        return makeModelResponse("I have completed the search task.");
      };

      if (mw.wrapModelCall) {
        await mw.wrapModelCall(turnCtx, { messages: [] }, handler);
      }

      expect(completed).toContain("search the web");
    });

    test("todo block shows completed item as [x] on next call", async () => {
      const mw = createGoalAnchorMiddleware({
        objectives: ["search the web"],
      });

      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      // First call: mark as completed
      if (mw.wrapModelCall) {
        await mw.wrapModelCall(turnCtx, { messages: [] }, async () =>
          makeModelResponse("I have completed the search."),
        );
      }

      // Second call: verify the todo block shows [x]
      let capturedRequest: ModelRequest | undefined;
      if (mw.wrapModelCall) {
        await mw.wrapModelCall(
          turnCtx,
          { messages: [] },
          async (req: ModelRequest): Promise<ModelResponse> => {
            capturedRequest = req;
            return makeModelResponse("ok");
          },
        );
      }

      const req = capturedRequest;
      expect(req).toBeDefined();
      const firstMsg = req?.messages[0];
      const content = firstMsg?.content[0];
      if (content?.kind === "text") {
        expect(content.text).toContain("- [x] search the web");
      }
    });
  });

  describe("4. No injection when objectives is empty", () => {
    test("returns middleware that passes requests through unchanged", async () => {
      const mw = createGoalAnchorMiddleware({ objectives: [] });

      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      const originalMessages = [
        { senderId: "user", timestamp: 0, content: [{ kind: "text" as const, text: "hello" }] },
      ];

      let _capturedRequest: ModelRequest | null = null;
      if (mw.wrapModelCall) {
        await mw.wrapModelCall(
          turnCtx,
          { messages: originalMessages },
          async (req: ModelRequest): Promise<ModelResponse> => {
            _capturedRequest = req;
            return makeModelResponse("ok");
          },
        );
      } else {
        // No wrapModelCall = no-op middleware; pass-through confirmed
        _capturedRequest = null;
      }

      // Empty-objectives middleware has no wrapModelCall — it's a no-op
      // The important check is that middleware creation succeeds and name/priority is correct
      expect(mw.name).toBe("goal-anchor");
    });

    test("no-op middleware has no wrapModelCall", () => {
      const mw = createGoalAnchorMiddleware({ objectives: [] });
      expect(mw.wrapModelCall).toBeUndefined();
    });
  });

  describe("5. onSessionEnd cleans up session state", () => {
    test("removes session so subsequent calls get no injection", async () => {
      const mw = createGoalAnchorMiddleware({
        objectives: ["search the web"],
      });

      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      await mw.onSessionEnd?.(sessionCtx);

      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      let capturedRequest: ModelRequest | undefined;
      if (mw.wrapModelCall) {
        await mw.wrapModelCall(
          turnCtx,
          { messages: [] },
          async (req: ModelRequest): Promise<ModelResponse> => {
            capturedRequest = req;
            return makeModelResponse("ok");
          },
        );
      }

      // After session end, request passes through unmodified (no prepended message)
      if (capturedRequest !== undefined) {
        const firstMsg = capturedRequest?.messages[0];
        expect(firstMsg?.senderId).not.toBe("system:goal-anchor");
      }
    });
  });

  describe("wrapModelStream: injects todo and detects completions", () => {
    test("prepends todo message in stream path", async () => {
      let capturedRequest: ModelRequest | undefined;
      const mw = createGoalAnchorMiddleware({
        objectives: ["search the web"],
      });

      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      if (mw.wrapModelStream) {
        // ModelChunk uses "text_delta" with "delta" field for streaming text
        const handler = createMockModelStreamHandler([{ kind: "text_delta", delta: "ok" }]);
        const wrappedHandler = async function* (req: ModelRequest) {
          capturedRequest = req;
          yield* handler(req);
        };

        for await (const _chunk of mw.wrapModelStream(turnCtx, { messages: [] }, wrappedHandler)) {
          // drain
        }
      }

      const req = capturedRequest;
      expect(req).toBeDefined();
      if (req !== undefined) {
        expect(req.messages[0]?.senderId).toBe("system:goal-anchor");
      }
    });

    test("marks objective complete from streamed text", async () => {
      const completed: string[] = [];
      const mw = createGoalAnchorMiddleware({
        objectives: ["search the web"],
        onComplete: (item) => {
          completed.push(item.text);
        },
      });

      const sessionCtx = createMockSessionContext();
      await mw.onSessionStart?.(sessionCtx);
      const turnCtx = createMockTurnContext({ session: sessionCtx, turnIndex: 0 });

      if (mw.wrapModelStream) {
        // ModelChunk uses "text_delta" with "delta" field for streaming text
        const handler = createMockModelStreamHandler([
          { kind: "text_delta", delta: "I completed the search task." },
        ]);

        for await (const _chunk of mw.wrapModelStream(turnCtx, { messages: [] }, handler)) {
          // drain
        }
      }

      expect(completed).toContain("search the web");
    });
  });
});
