/**
 * Unit tests for pure todo state functions.
 */

import { describe, expect, test } from "bun:test";
import { createTodoState, detectCompletions, renderTodoBlock } from "./todo.js";

describe("createTodoState", () => {
  test("creates items with sequential IDs", () => {
    const state = createTodoState(["search the web", "write a report"]);
    expect(state.items[0]?.id).toBe("obj-0");
    expect(state.items[1]?.id).toBe("obj-1");
  });

  test("all items start as pending", () => {
    const state = createTodoState(["task 1", "task 2"]);
    for (const item of state.items) {
      expect(item.status).toBe("pending");
    }
  });

  test("preserves objective text", () => {
    const state = createTodoState(["search the web"]);
    expect(state.items[0]?.text).toBe("search the web");
  });

  test("empty objectives creates empty state", () => {
    const state = createTodoState([]);
    expect(state.items).toHaveLength(0);
  });
});

describe("renderTodoBlock", () => {
  test("renders header followed by items", () => {
    const state = createTodoState(["task 1"]);
    const block = renderTodoBlock(state, "## Tasks");
    expect(block).toContain("## Tasks");
    expect(block).toContain("- [ ] task 1");
  });

  test("renders completed items with [x]", () => {
    const state = {
      items: [
        { id: "obj-0", text: "task 1", status: "completed" as const },
        { id: "obj-1", text: "task 2", status: "pending" as const },
      ],
    };
    const block = renderTodoBlock(state, "## Tasks");
    expect(block).toContain("- [x] task 1");
    expect(block).toContain("- [ ] task 2");
  });

  test("uses custom header", () => {
    const state = createTodoState(["task 1"]);
    const block = renderTodoBlock(state, "## Current Objectives");
    expect(block.startsWith("## Current Objectives")).toBe(true);
  });
});

describe("detectCompletions", () => {
  test("fast path: returns same state reference when no completion signals", () => {
    const state = createTodoState(["search the web"]);
    const result = detectCompletions("still working on it", state);
    expect(result).toBe(state); // same reference
  });

  test("marks item complete when response has completion keyword and mentions objective", () => {
    const state = createTodoState(["search the web"]);
    const result = detectCompletions("I have completed the search operation.", state);
    expect(result.items[0]?.status).toBe("completed");
  });

  test("does not mark complete if objective keywords not mentioned", () => {
    const state = createTodoState(["write a report"]);
    const result = detectCompletions("I have completed the search operation.", state);
    // "write" and "report" are not mentioned
    expect(result.items[0]?.status).toBe("pending");
  });

  test("already completed items are not double-processed", () => {
    const state = {
      items: [{ id: "obj-0", text: "search the web", status: "completed" as const }],
    };
    const result = detectCompletions("I completed the search.", state);
    // Same item reference (no change needed)
    expect(result.items[0]).toBe(state.items[0]);
  });

  test("detects [x] completion pattern", () => {
    const state = createTodoState(["search the web"]);
    const result = detectCompletions("[x] search task completed", state);
    expect(result.items[0]?.status).toBe("completed");
  });

  test("detects ✅ completion pattern", () => {
    const state = createTodoState(["write report"]);
    const result = detectCompletions("✅ report writing done", state);
    expect(result.items[0]?.status).toBe("completed");
  });
});
