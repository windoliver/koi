import { describe, expect, it } from "bun:test";
import type { ElicitationResult } from "@koi/core/elicitation";
import { createAskUserTool } from "./ask-user-tool.js";
import type { AskUserConfig, ElicitationHandler } from "./types.js";

/** Helper to create a handler that returns a fixed response. */
function fixedHandler(response: ElicitationResult): ElicitationHandler {
  return async () => response;
}

/** Minimal valid question args for the tool. */
const validArgs = {
  question: "Which caching strategy should we use?",
  options: [
    { label: "Redis", description: "Distributed cache" },
    { label: "In-memory", description: "Local process cache" },
  ],
};

/** Creates a tool with a fixed-response handler. */
function createToolWithHandler(
  response: ElicitationResult,
  overrides?: Partial<AskUserConfig>,
): ReturnType<typeof createAskUserTool> {
  return createAskUserTool({
    handler: fixedHandler(response),
    ...overrides,
  });
}

describe("createAskUserTool", () => {
  describe("happy path", () => {
    it("returns selected option for valid single-select question", async () => {
      const tool = createToolWithHandler({ selected: ["Redis"] });
      const result = await tool.execute(validArgs);
      expect(result).toEqual({ selected: ["Redis"] });
    });

    it("returns multiple selections for multi-select question", async () => {
      const tool = createToolWithHandler({
        selected: ["Redis", "In-memory"],
      });
      const result = await tool.execute({
        ...validArgs,
        multiSelect: true,
      });
      expect(result).toEqual({ selected: ["Redis", "In-memory"] });
    });

    it("returns free-text response", async () => {
      const tool = createToolWithHandler({
        selected: [],
        freeText: "Custom caching with LRU",
      });
      const result = await tool.execute(validArgs);
      expect(result).toEqual({
        selected: [],
        freeText: "Custom caching with LRU",
      });
    });

    it("accepts multiSelect: true with single selection", async () => {
      const tool = createToolWithHandler({ selected: ["Redis"] });
      const result = await tool.execute({
        ...validArgs,
        multiSelect: true,
      });
      expect(result).toEqual({ selected: ["Redis"] });
    });
  });

  describe("input validation (model sends bad args)", () => {
    const tool = createToolWithHandler({ selected: ["Redis"] });

    it("returns VALIDATION error for missing question", async () => {
      const result = (await tool.execute({
        options: validArgs.options,
      })) as { code: string };
      expect(result.code).toBe("VALIDATION");
    });

    it("returns VALIDATION error for empty options", async () => {
      const result = (await tool.execute({
        question: "Which?",
        options: [],
      })) as { code: string };
      expect(result.code).toBe("VALIDATION");
    });

    it("returns VALIDATION error when options exceed maxOptions", async () => {
      const tool = createToolWithHandler({ selected: ["A"] }, { maxOptions: 2 });
      const result = (await tool.execute({
        question: "Which?",
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "B" },
          { label: "C", description: "C" },
        ],
      })) as { code: string };
      expect(result.code).toBe("VALIDATION");
    });

    it("returns VALIDATION error for invalid option shape", async () => {
      const result = (await tool.execute({
        question: "Which?",
        options: [{ label: "A" }, { label: "B", description: "B" }],
      })) as { code: string };
      expect(result.code).toBe("VALIDATION");
    });

    it("returns VALIDATION error when header exceeds 12 chars", async () => {
      const result = (await tool.execute({
        ...validArgs,
        header: "This is way too long",
      })) as { code: string };
      expect(result.code).toBe("VALIDATION");
    });
  });

  describe("response validation (handler returns bad data)", () => {
    it("returns VALIDATION error when selected label not in options", async () => {
      const tool = createToolWithHandler({ selected: ["Nonexistent"] });
      const result = (await tool.execute(validArgs)) as { code: string; error: string };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("unknown option(s)");
    });

    it("returns VALIDATION error for multiSelect false with two selections", async () => {
      const tool = createToolWithHandler({
        selected: ["Redis", "In-memory"],
      });
      const result = (await tool.execute(validArgs)) as { code: string; error: string };
      expect(result.code).toBe("VALIDATION");
      expect(result.error).toContain("multiple selections not allowed");
    });

    it("returns VALIDATION error for empty response", async () => {
      const tool = createToolWithHandler({ selected: [] });
      const result = (await tool.execute(validArgs)) as { code: string };
      expect(result.code).toBe("VALIDATION");
    });
  });

  describe("timeout and cancellation", () => {
    it("returns TIMEOUT error when handler takes too long", async () => {
      const handler: ElicitationHandler = async (_question, signal) => {
        // Wait for the signal to abort
        return new Promise<ElicitationResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      };
      const tool = createAskUserTool({ handler, timeoutMs: 50 });

      const result = (await tool.execute(validArgs)) as { code: string };
      expect(result.code).toBe("TIMEOUT");
    });

    it("returns TIMEOUT error when engine signal aborts", async () => {
      const controller = new AbortController();
      const handler: ElicitationHandler = async (_question, signal) => {
        return new Promise<ElicitationResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      };
      const tool = createAskUserTool({ handler, timeoutMs: 60_000 });

      // Abort immediately after a microtask
      setTimeout(() => {
        controller.abort();
      }, 10);

      const result = (await tool.execute(validArgs, {
        signal: controller.signal,
      })) as { code: string };
      expect(result.code).toBe("TIMEOUT");
    });
  });

  describe("error handling", () => {
    it("returns EXTERNAL error when handler throws unexpected error", async () => {
      const handler: ElicitationHandler = async () => {
        throw new Error("channel disconnected");
      };
      const tool = createAskUserTool({ handler });

      const result = (await tool.execute(validArgs)) as {
        code: string;
        error: string;
      };
      expect(result.code).toBe("EXTERNAL");
      expect(result.error).toBe("channel disconnected");
    });

    it("returns EXTERNAL error for non-Error throws", async () => {
      const handler: ElicitationHandler = async () => {
        throw "string error"; // eslint-disable-line no-throw-literal
      };
      const tool = createAskUserTool({ handler });

      const result = (await tool.execute(validArgs)) as {
        code: string;
        error: string;
      };
      expect(result.code).toBe("EXTERNAL");
      expect(result.error).toBe("Unknown handler error");
    });
  });

  describe("edge cases", () => {
    it("handles options with duplicate labels gracefully", async () => {
      const tool = createToolWithHandler({ selected: ["Same"] });
      const result = await tool.execute({
        question: "Pick one?",
        options: [
          { label: "Same", description: "First same" },
          { label: "Same", description: "Second same" },
        ],
      });
      expect(result).toEqual({ selected: ["Same"] });
    });

    it("uses default maxOptions of 6", async () => {
      const tool = createToolWithHandler({ selected: ["A"] });
      const sixOptions = Array.from({ length: 6 }, (_, i) => ({
        label: String.fromCharCode(65 + i),
        description: `Option ${String.fromCharCode(65 + i)}`,
      }));
      const result = await tool.execute({
        question: "Pick?",
        options: sixOptions,
      });
      expect(result).toEqual({ selected: ["A"] });
    });

    it("has descriptor with name ask_user", () => {
      const tool = createToolWithHandler({ selected: [] });
      expect(tool.descriptor.name).toBe("ask_user");
    });

    it("has trustTier verified", () => {
      const tool = createToolWithHandler({ selected: [] });
      expect(tool.trustTier).toBe("verified");
    });
  });
});
