import { describe, expect, test } from "bun:test";
import type { PipelineStep } from "./pipeline-executor.js";
import { executePipeline, generatePipelineExecutorCode } from "./pipeline-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createExecutor(
  results: readonly unknown[],
): (toolId: string, args: unknown) => Promise<unknown> {
  let callIndex = 0; // justified: mutable counter for test mock
  return async (_toolId: string, _args: unknown): Promise<unknown> => {
    const result = results[callIndex];
    callIndex += 1;
    return result;
  };
}

function createFailingExecutor(
  failAtStep: number,
  errorMessage: string,
): (toolId: string, args: unknown) => Promise<unknown> {
  let callIndex = 0; // justified: mutable counter for test mock
  return async (_toolId: string, _args: unknown): Promise<unknown> => {
    const current = callIndex;
    callIndex += 1;
    if (current === failAtStep) {
      throw new Error(errorMessage);
    }
    return `result-${String(current)}`;
  };
}

// ---------------------------------------------------------------------------
// executePipeline
// ---------------------------------------------------------------------------

describe("executePipeline", () => {
  test("returns ok with value for single step", async () => {
    const steps: readonly PipelineStep[] = [{ toolId: "fetch" }];
    const result = await executePipeline(steps, { executor: createExecutor(["data"]) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("data");
    expect(result.partialResults).toEqual(["data"]);
  });

  test("threads results forward through steps", async () => {
    const calls: Array<{ toolId: string; args: unknown }> = [];
    const executor = async (toolId: string, args: unknown): Promise<unknown> => {
      // justified: mutable local array for test tracking
      calls.push({ toolId, args });
      return `${toolId}-result`;
    };

    const steps: readonly PipelineStep[] = [
      { toolId: "fetch" },
      { toolId: "parse" },
      { toolId: "save" },
    ];

    const result = await executePipeline(steps, { executor }, "initial-args");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("save-result");
    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toBe("initial-args");
    expect(calls[1]?.args).toBe("fetch-result");
    expect(calls[2]?.args).toBe("parse-result");
  });

  test("returns empty result for empty pipeline", async () => {
    const result = await executePipeline([], { executor: createExecutor([]) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
    expect(result.partialResults).toEqual([]);
  });

  test("reports failure at correct step when executor throws", async () => {
    const steps: readonly PipelineStep[] = [
      { toolId: "fetch" },
      { toolId: "parse" },
      { toolId: "save" },
    ];

    const result = await executePipeline(steps, {
      executor: createFailingExecutor(1, "parse error"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedAtStep).toBe(1);
    expect(result.error).toContain("parse");
    expect(result.partialResults).toHaveLength(1);
    expect(result.partialResults[0]).toBe("result-0");
  });

  test("captures partial results on failure", async () => {
    const steps: readonly PipelineStep[] = [
      { toolId: "a" },
      { toolId: "b" },
      { toolId: "c" },
      { toolId: "d" },
    ];

    const result = await executePipeline(steps, {
      executor: createFailingExecutor(2, "step c failed"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedAtStep).toBe(2);
    expect(result.partialResults).toHaveLength(2);
  });

  test("passes firstToolArgs to first step", async () => {
    let receivedArgs: unknown;
    const executor = async (_toolId: string, args: unknown): Promise<unknown> => {
      receivedArgs = args;
      return "done";
    };

    await executePipeline([{ toolId: "fetch" }], { executor }, { url: "https://example.com" });

    expect(receivedArgs).toEqual({ url: "https://example.com" });
  });

  test("first step receives undefined when no firstToolArgs", async () => {
    let receivedArgs: unknown = "sentinel";
    const executor = async (_toolId: string, args: unknown): Promise<unknown> => {
      receivedArgs = args;
      return "done";
    };

    await executePipeline([{ toolId: "fetch" }], { executor });

    expect(receivedArgs).toBeUndefined();
  });

  test("failure at first step returns empty partial results", async () => {
    const result = await executePipeline([{ toolId: "fetch" }, { toolId: "parse" }], {
      executor: createFailingExecutor(0, "network error"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedAtStep).toBe(0);
    expect(result.partialResults).toHaveLength(0);
    expect(result.error).toContain("network error");
  });

  test("includes all results in partialResults on success", async () => {
    const result = await executePipeline([{ toolId: "a" }, { toolId: "b" }, { toolId: "c" }], {
      executor: createExecutor(["r1", "r2", "r3"]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.partialResults).toEqual(["r1", "r2", "r3"]);
    expect(result.value).toBe("r3");
  });

  test("handles non-Error thrown values", async () => {
    const executor = async (): Promise<unknown> => {
      throw "string error";
    };

    const result = await executePipeline([{ toolId: "a" }], { executor });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("string error");
  });
});

// ---------------------------------------------------------------------------
// generatePipelineExecutorCode
// ---------------------------------------------------------------------------

describe("generatePipelineExecutorCode", () => {
  test("includes import statement", () => {
    const code = generatePipelineExecutorCode([{ toolId: "fetch" }], 5);
    expect(code).toContain("import { executePipeline }");
  });

  test("includes step array as const", () => {
    const code = generatePipelineExecutorCode([{ toolId: "fetch" }, { toolId: "parse" }], 3);
    expect(code).toContain('"fetch"');
    expect(code).toContain('"parse"');
    expect(code).toContain("as const");
  });

  test("includes pattern comment with occurrences", () => {
    const code = generatePipelineExecutorCode([{ toolId: "a" }, { toolId: "b" }], 7);
    expect(code).toContain("7 occurrences");
  });
});
