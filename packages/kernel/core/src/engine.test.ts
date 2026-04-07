/**
 * Exhaustiveness and shape tests for EngineEvent, ChannelStatus, and
 * mapContentBlocksForEngine types.
 */

import { describe, expect, test } from "bun:test";
import type {
  ChannelStatus,
  ChannelStatusKind,
  ContentBlock,
  EngineCapabilities,
  EngineEvent,
} from "./index.js";
import { agentId, mapContentBlocksForEngine, toolCallId } from "./index.js";

// ---------------------------------------------------------------------------
// EngineEvent exhaustiveness (compile-time + runtime)
// ---------------------------------------------------------------------------

/**
 * Compile-time exhaustiveness check: if a new variant is added to EngineEvent
 * but this function is not updated, TypeScript will error on the `never` branch.
 */
function engineEventLabel(event: EngineEvent): string {
  switch (event.kind) {
    case "turn_start":
      return "start";
    case "text_delta":
      return "delta";
    case "thinking_delta":
      return "thinking";
    case "tool_call_start":
      return "tcs";
    case "tool_call_delta":
      return "tcd";
    case "tool_call_end":
      return "tce";
    case "turn_end":
      return "end";
    case "done":
      return "done";
    case "custom":
      return "custom";
    case "discovery:miss":
      return "miss";
    case "spawn_requested":
      return "spawn";
    case "agent_spawned":
      return "spawned";
    case "agent_status_changed":
      return "status";
    case "permission_attempt":
      return "permission";
    case "plan_update":
      return "plan";
    case "task_progress":
      return "progress";
    default: {
      const _exhaustive: never = event;
      return String(_exhaustive);
    }
  }
}

describe("EngineEvent exhaustiveness", () => {
  test("turn_start variant is handled", () => {
    const event: EngineEvent = { kind: "turn_start", turnIndex: 0 };
    expect(engineEventLabel(event)).toBe("start");
  });

  test("text_delta variant is handled", () => {
    const event: EngineEvent = { kind: "text_delta", delta: "hi" };
    expect(engineEventLabel(event)).toBe("delta");
  });

  test("thinking_delta variant is handled", () => {
    const event: EngineEvent = { kind: "thinking_delta", delta: "hmm" };
    expect(engineEventLabel(event)).toBe("thinking");
  });

  test("tool_call_start variant is handled", () => {
    const event: EngineEvent = {
      kind: "tool_call_start",
      toolName: "calc",
      callId: toolCallId("c1"),
      args: {},
    };
    expect(engineEventLabel(event)).toBe("tcs");
  });

  test("tool_call_delta variant is handled", () => {
    const event: EngineEvent = { kind: "tool_call_delta", callId: toolCallId("c1"), delta: "{}" };
    expect(engineEventLabel(event)).toBe("tcd");
  });

  test("tool_call_end variant is handled", () => {
    const event: EngineEvent = { kind: "tool_call_end", callId: toolCallId("c1"), result: 42 };
    expect(engineEventLabel(event)).toBe("tce");
  });

  test("turn_end variant is handled", () => {
    const event: EngineEvent = { kind: "turn_end", turnIndex: 0 };
    expect(engineEventLabel(event)).toBe("end");
  });

  test("done variant is handled", () => {
    const event: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "completed",
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
      },
    };
    expect(engineEventLabel(event)).toBe("done");
  });

  test("custom variant is handled", () => {
    const event: EngineEvent = { kind: "custom", type: "x", data: null };
    expect(engineEventLabel(event)).toBe("custom");
  });

  test("discovery:miss variant is handled", () => {
    const event: EngineEvent = {
      kind: "discovery:miss",
      resolverSource: "forge",
      timestamp: Date.now(),
    };
    expect(engineEventLabel(event)).toBe("miss");
  });

  test("spawn_requested variant is handled", () => {
    const event: EngineEvent = {
      kind: "spawn_requested",
      request: {
        description: "research task",
        agentName: "researcher",
        signal: AbortSignal.timeout(5000),
      },
      childAgentId: agentId("child-1"),
    };
    expect(engineEventLabel(event)).toBe("spawn");
  });

  test("agent_spawned variant is handled", () => {
    const event: EngineEvent = {
      kind: "agent_spawned",
      agentId: agentId("child-1"),
      agentName: "researcher",
      parentAgentId: agentId("main"),
    };
    expect(engineEventLabel(event)).toBe("spawned");
  });

  test("agent_spawned without parent is handled", () => {
    const event: EngineEvent = {
      kind: "agent_spawned",
      agentId: agentId("child-1"),
      agentName: "researcher",
    };
    expect(engineEventLabel(event)).toBe("spawned");
  });

  test("agent_status_changed variant is handled", () => {
    const event: EngineEvent = {
      kind: "agent_status_changed",
      agentId: agentId("child-1"),
      agentName: "researcher",
      status: "running",
      previousStatus: "created",
    };
    expect(engineEventLabel(event)).toBe("status");
  });

  test("plan_update variant is handled", () => {
    const event: EngineEvent = {
      kind: "plan_update",
      agentId: agentId("main"),
      tasks: [
        {
          id: "task-1" as import("./task-board.js").TaskItemId,
          subject: "Research auth options",
          status: "in_progress",
          assignedTo: agentId("main"),
          dependencies: [],
        },
        {
          id: "task-2" as import("./task-board.js").TaskItemId,
          subject: "Implement login",
          status: "pending",
          dependencies: ["task-1" as import("./task-board.js").TaskItemId],
        },
      ],
      timestamp: Date.now(),
    };
    expect(engineEventLabel(event)).toBe("plan");
  });

  test("plan_update with blockedBy is handled", () => {
    const event: EngineEvent = {
      kind: "plan_update",
      agentId: agentId("main"),
      tasks: [
        {
          id: "task-1" as import("./task-board.js").TaskItemId,
          subject: "Failed task",
          status: "failed",
          dependencies: [],
        },
        {
          id: "task-2" as import("./task-board.js").TaskItemId,
          subject: "Blocked task",
          status: "pending",
          blockedBy: "task-1" as import("./task-board.js").TaskItemId,
          dependencies: ["task-1" as import("./task-board.js").TaskItemId],
        },
      ],
      timestamp: Date.now(),
    };
    expect(engineEventLabel(event)).toBe("plan");
  });

  test("task_progress variant is handled", () => {
    const event: EngineEvent = {
      kind: "task_progress",
      agentId: agentId("main"),
      taskId: "task-1" as import("./task-board.js").TaskItemId,
      subject: "Research auth options",
      previousStatus: "pending",
      status: "in_progress",
      activeForm: "Researching auth options",
      timestamp: Date.now(),
    };
    expect(engineEventLabel(event)).toBe("progress");
  });

  test("task_progress with detail is handled", () => {
    const event: EngineEvent = {
      kind: "task_progress",
      agentId: agentId("main"),
      taskId: "task-1" as import("./task-board.js").TaskItemId,
      subject: "Research auth options",
      previousStatus: "in_progress",
      status: "failed",
      detail: "API returned 500",
      timestamp: Date.now(),
    };
    expect(engineEventLabel(event)).toBe("progress");
  });
});

// ---------------------------------------------------------------------------
// ChannelStatus shape tests
// ---------------------------------------------------------------------------

describe("ChannelStatus shape", () => {
  test("processing status has required fields", () => {
    const status: ChannelStatus = { kind: "processing", turnIndex: 0 };
    expect(status.kind).toBe("processing");
    expect(status.turnIndex).toBe(0);
  });

  test("idle status with optional fields", () => {
    const status: ChannelStatus = {
      kind: "idle",
      turnIndex: 1,
      messageRef: "msg-123",
      detail: "done thinking",
      metadata: { source: "test" },
    };
    expect(status.kind).toBe("idle");
    expect(status.turnIndex).toBe(1);
    expect(status.messageRef).toBe("msg-123");
    expect(status.detail).toBe("done thinking");
    expect(status.metadata).toEqual({ source: "test" });
  });

  test("error status is valid", () => {
    const status: ChannelStatus = { kind: "error", turnIndex: 0 };
    expect(status.kind).toBe("error");
  });

  test("ChannelStatusKind type covers all values", () => {
    const kinds: readonly ChannelStatusKind[] = ["processing", "idle", "error"];
    expect(kinds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// mapContentBlocksForEngine
// ---------------------------------------------------------------------------

describe("mapContentBlocksForEngine", () => {
  const ALL_CAPABLE: EngineCapabilities = {
    text: true,
    images: true,
    files: true,
    audio: true,
  };

  const TEXT_ONLY: EngineCapabilities = {
    text: true,
    images: false,
    files: false,
    audio: false,
  };

  const IMAGES_ONLY: EngineCapabilities = {
    text: true,
    images: true,
    files: false,
    audio: false,
  };

  const FILES_ONLY: EngineCapabilities = {
    text: true,
    images: false,
    files: true,
    audio: false,
  };

  test("fast path: returns same array reference when images and files are true", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "hello" },
      { kind: "image", url: "https://img.png", alt: "photo" },
      { kind: "file", url: "https://file.pdf", mimeType: "application/pdf", name: "doc.pdf" },
    ];
    const result = mapContentBlocksForEngine(blocks, ALL_CAPABLE);
    expect(result).toBe(blocks); // same reference
  });

  test("image downgrade uses alt text when available", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "image", url: "https://img.png", alt: "a cat" },
    ];
    const result = mapContentBlocksForEngine(blocks, TEXT_ONLY);
    expect(result).toEqual([{ kind: "text", text: "[Image: a cat]" }]);
  });

  test("image downgrade uses url when alt is missing", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "image", url: "https://img.png" }];
    const result = mapContentBlocksForEngine(blocks, TEXT_ONLY);
    expect(result).toEqual([{ kind: "text", text: "[Image: https://img.png]" }]);
  });

  test("file downgrade uses name when available", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "file", url: "https://file.pdf", mimeType: "application/pdf", name: "report.pdf" },
    ];
    const result = mapContentBlocksForEngine(blocks, TEXT_ONLY);
    expect(result).toEqual([{ kind: "text", text: "[File: report.pdf]" }]);
  });

  test("file downgrade uses url when name is missing", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "file", url: "https://file.pdf", mimeType: "application/pdf" },
    ];
    const result = mapContentBlocksForEngine(blocks, TEXT_ONLY);
    expect(result).toEqual([{ kind: "text", text: "[File: https://file.pdf]" }]);
  });

  test("text block always passes through unchanged", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "text", text: "hello" }];
    const result = mapContentBlocksForEngine(blocks, TEXT_ONLY);
    expect(result).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("button block always passes through unchanged", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "button", label: "Click", action: "submit" }];
    const result = mapContentBlocksForEngine(blocks, TEXT_ONLY);
    expect(result).toEqual([{ kind: "button", label: "Click", action: "submit" }]);
  });

  test("custom block always passes through unchanged", () => {
    const blocks: readonly ContentBlock[] = [{ kind: "custom", type: "chart", data: { x: 1 } }];
    const result = mapContentBlocksForEngine(blocks, TEXT_ONLY);
    expect(result).toEqual([{ kind: "custom", type: "chart", data: { x: 1 } }]);
  });

  test("mixed blocks: only unsupported blocks are downgraded", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "text", text: "intro" },
      { kind: "image", url: "https://img.png", alt: "photo" },
      { kind: "file", url: "https://f.pdf", mimeType: "application/pdf", name: "doc.pdf" },
      { kind: "button", label: "Go", action: "go" },
    ];
    const result = mapContentBlocksForEngine(blocks, TEXT_ONLY);
    expect(result).toEqual([
      { kind: "text", text: "intro" },
      { kind: "text", text: "[Image: photo]" },
      { kind: "text", text: "[File: doc.pdf]" },
      { kind: "button", label: "Go", action: "go" },
    ]);
  });

  test("images capable but files not: only files downgraded", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "image", url: "https://img.png", alt: "photo" },
      { kind: "file", url: "https://f.pdf", mimeType: "application/pdf", name: "doc.pdf" },
    ];
    const result = mapContentBlocksForEngine(blocks, IMAGES_ONLY);
    expect(result).toEqual([
      { kind: "image", url: "https://img.png", alt: "photo" },
      { kind: "text", text: "[File: doc.pdf]" },
    ]);
  });

  test("files capable but images not: only images downgraded", () => {
    const blocks: readonly ContentBlock[] = [
      { kind: "image", url: "https://img.png", alt: "photo" },
      { kind: "file", url: "https://f.pdf", mimeType: "application/pdf", name: "doc.pdf" },
    ];
    const result = mapContentBlocksForEngine(blocks, FILES_ONLY);
    expect(result).toEqual([
      { kind: "text", text: "[Image: photo]" },
      { kind: "file", url: "https://f.pdf", mimeType: "application/pdf", name: "doc.pdf" },
    ]);
  });

  test("empty input returns empty array", () => {
    const result = mapContentBlocksForEngine([], TEXT_ONLY);
    expect(result).toEqual([]);
  });
});
