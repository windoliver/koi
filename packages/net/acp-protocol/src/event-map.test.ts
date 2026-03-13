/**
 * Tests for bidirectional ACP ↔ Koi event mapping.
 */

import { describe, expect, test } from "bun:test";
import type { AgentId, EngineEvent } from "@koi/core";
import { toolCallId } from "@koi/core";
import type { SessionUpdatePayload } from "./acp-schema.js";
import { mapEngineEventToAcp, mapSessionUpdate } from "./event-map.js";

// ---------------------------------------------------------------------------
// ACP → Koi (mapSessionUpdate) — existing tests
// ---------------------------------------------------------------------------

describe("mapSessionUpdate — agent_message_chunk", () => {
  test("maps text block to text_delta event", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "text", text: "Hello world" }],
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("text_delta");
    if (events[0]?.kind === "text_delta") {
      expect(events[0].delta).toBe("Hello world");
    }
  });

  test("maps multiple text blocks to multiple text_delta events", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "agent_message_chunk",
      content: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("text_delta");
    expect(events[1]?.kind).toBe("text_delta");
  });

  test("skips empty text blocks", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "text", text: "" }],
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(0);
  });

  test("maps image block to custom acp:image_block event", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "agent_message_chunk",
      content: [{ type: "image", mimeType: "image/png", data: "base64==" }],
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("custom");
    if (events[0]?.kind === "custom") {
      expect(events[0].type).toBe("acp:image_block");
    }
  });
});

describe("mapSessionUpdate — agent_thought_chunk", () => {
  test("maps to custom acp:thought event", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "I need to think..." },
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("custom");
    if (events[0]?.kind === "custom") {
      expect(events[0].type).toBe("acp:thought");
    }
  });
});

describe("mapSessionUpdate — tool_call", () => {
  test("maps to tool_call_start event", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "tool_call",
      toolCallId: "tc_abc123",
      title: "Read file.ts",
      kind: "read",
      status: "pending",
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe("tool_call_start");
    if (event?.kind === "tool_call_start") {
      expect(event.toolName).toBe("Read file.ts");
      expect(String(event.callId)).toBe("tc_abc123");
    }
  });

  test("includes rawInput as args when present", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "tool_call",
      toolCallId: "tc_1",
      title: "Write file",
      kind: "edit",
      status: "in_progress",
      rawInput: { path: "/foo.ts", content: "hello" },
    };
    const events = mapSessionUpdate(update);
    expect(events[0]?.kind).toBe("tool_call_start");
    if (events[0]?.kind === "tool_call_start") {
      expect(events[0].args).toEqual({ path: "/foo.ts", content: "hello" });
    }
  });
});

describe("mapSessionUpdate — tool_call_update", () => {
  test("maps completed status to tool_call_end event", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_abc",
      status: "completed",
      content: [{ type: "text", text: "Done" }],
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("tool_call_end");
    if (events[0]?.kind === "tool_call_end") {
      expect(events[0].result).toBe("Done");
    }
  });

  test("maps failed status to tool_call_end event", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_abc",
      status: "failed",
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("tool_call_end");
  });

  test("maps in_progress status to custom event", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc_abc",
      status: "in_progress",
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("custom");
    if (events[0]?.kind === "custom") {
      expect(events[0].type).toBe("acp:tool_call_update");
    }
  });
});

describe("mapSessionUpdate — plan", () => {
  test("maps to custom acp:plan event", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "plan",
      content: [{ type: "text", text: "Step 1: Read file\nStep 2: Edit" }],
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("custom");
    if (events[0]?.kind === "custom") {
      expect(events[0].type).toBe("acp:plan");
    }
  });
});

describe("mapSessionUpdate — current_mode_update", () => {
  test("maps to custom acp:mode_change event", () => {
    const update: SessionUpdatePayload = {
      sessionUpdate: "current_mode_update",
      mode: "auto",
    };
    const events = mapSessionUpdate(update);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("custom");
    if (events[0]?.kind === "custom") {
      expect(events[0].type).toBe("acp:mode_change");
      expect((events[0].data as { mode: string }).mode).toBe("auto");
    }
  });
});

// ---------------------------------------------------------------------------
// Koi → ACP (mapEngineEventToAcp) — new reverse mapper tests
// ---------------------------------------------------------------------------

describe("mapEngineEventToAcp — text_delta", () => {
  test("maps to agent_message_chunk", () => {
    const event: EngineEvent = { kind: "text_delta", delta: "Hello" };
    const result = mapEngineEventToAcp(event);
    expect(result).toBeDefined();
    expect(result?.sessionUpdate).toBe("agent_message_chunk");
    if (result?.sessionUpdate === "agent_message_chunk") {
      expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
    }
  });
});

describe("mapEngineEventToAcp — tool_call_start", () => {
  test("maps to tool_call with pending status", () => {
    const event: EngineEvent = {
      kind: "tool_call_start",
      toolName: "Read file",
      callId: toolCallId("tc_1"),
    };
    const result = mapEngineEventToAcp(event);
    expect(result).toBeDefined();
    expect(result?.sessionUpdate).toBe("tool_call");
    if (result?.sessionUpdate === "tool_call") {
      expect(result.toolCallId).toBe("tc_1");
      expect(result.title).toBe("Read file");
      expect(result.status).toBe("pending");
    }
  });

  test("includes rawInput when args present", () => {
    const event: EngineEvent = {
      kind: "tool_call_start",
      toolName: "Write file",
      callId: toolCallId("tc_2"),
      args: { path: "/foo.ts" },
    };
    const result = mapEngineEventToAcp(event);
    if (result?.sessionUpdate === "tool_call") {
      expect(result.rawInput).toEqual({ path: "/foo.ts" });
    }
  });
});

describe("mapEngineEventToAcp — tool_call_delta", () => {
  test("maps to tool_call_update with in_progress status", () => {
    const event: EngineEvent = {
      kind: "tool_call_delta",
      callId: toolCallId("tc_1"),
      delta: "partial output",
    };
    const result = mapEngineEventToAcp(event);
    expect(result?.sessionUpdate).toBe("tool_call_update");
    if (result?.sessionUpdate === "tool_call_update") {
      expect(result.status).toBe("in_progress");
      expect(result.content).toEqual([{ type: "text", text: "partial output" }]);
    }
  });
});

describe("mapEngineEventToAcp — tool_call_end", () => {
  test("maps to tool_call_update with completed status", () => {
    const event: EngineEvent = {
      kind: "tool_call_end",
      callId: toolCallId("tc_1"),
      result: "Done",
    };
    const result = mapEngineEventToAcp(event);
    expect(result?.sessionUpdate).toBe("tool_call_update");
    if (result?.sessionUpdate === "tool_call_update") {
      expect(result.status).toBe("completed");
      expect(result.content).toEqual([{ type: "text", text: "Done" }]);
    }
  });

  test("serializes non-string result to JSON", () => {
    const event: EngineEvent = {
      kind: "tool_call_end",
      callId: toolCallId("tc_1"),
      result: { output: 42 },
    };
    const result = mapEngineEventToAcp(event);
    if (result?.sessionUpdate === "tool_call_update") {
      expect(result.content).toEqual([{ type: "text", text: '{"output":42}' }]);
    }
  });
});

describe("mapEngineEventToAcp — custom events", () => {
  test("maps acp:thought to agent_thought_chunk", () => {
    const event: EngineEvent = {
      kind: "custom",
      type: "acp:thought",
      data: { text: "thinking..." },
    };
    const result = mapEngineEventToAcp(event);
    expect(result?.sessionUpdate).toBe("agent_thought_chunk");
  });

  test("maps acp:plan to plan", () => {
    const event: EngineEvent = {
      kind: "custom",
      type: "acp:plan",
      data: { text: "Step 1" },
    };
    const result = mapEngineEventToAcp(event);
    expect(result?.sessionUpdate).toBe("plan");
  });

  test("maps acp:mode_change to current_mode_update", () => {
    const event: EngineEvent = {
      kind: "custom",
      type: "acp:mode_change",
      data: { mode: "auto" },
    };
    const result = mapEngineEventToAcp(event);
    expect(result?.sessionUpdate).toBe("current_mode_update");
    if (result?.sessionUpdate === "current_mode_update") {
      expect(result.mode).toBe("auto");
    }
  });

  test("returns undefined for non-ACP custom events", () => {
    const event: EngineEvent = {
      kind: "custom",
      type: "ui:widget",
      data: { x: 1 },
    };
    expect(mapEngineEventToAcp(event)).toBeUndefined();
  });
});

describe("mapEngineEventToAcp — nested agent events", () => {
  test("maps agent_spawned to agent_thought_chunk", () => {
    const event: EngineEvent = {
      kind: "agent_spawned",
      agentId: "child-1" as AgentId,
      agentName: "researcher",
      parentAgentId: "main" as AgentId,
    };
    const result = mapEngineEventToAcp(event);
    expect(result).toBeDefined();
    expect(result?.sessionUpdate).toBe("agent_thought_chunk");
    if (result?.sessionUpdate === "agent_thought_chunk") {
      expect(result.content.text).toContain("researcher");
      expect(result.content.text).toContain("parent: main");
    }
  });

  test("maps agent_spawned without parent", () => {
    const event: EngineEvent = {
      kind: "agent_spawned",
      agentId: "child-1" as AgentId,
      agentName: "researcher",
    };
    const result = mapEngineEventToAcp(event);
    expect(result?.sessionUpdate).toBe("agent_thought_chunk");
    if (result?.sessionUpdate === "agent_thought_chunk") {
      expect(result.content.text).not.toContain("parent:");
    }
  });

  test("maps agent_status_changed to agent_thought_chunk", () => {
    const event: EngineEvent = {
      kind: "agent_status_changed",
      agentId: "child-1" as AgentId,
      agentName: "researcher",
      status: "running",
      previousStatus: "created",
    };
    const result = mapEngineEventToAcp(event);
    expect(result).toBeDefined();
    expect(result?.sessionUpdate).toBe("agent_thought_chunk");
    if (result?.sessionUpdate === "agent_thought_chunk") {
      expect(result.content.text).toContain("researcher");
      expect(result.content.text).toContain("created");
      expect(result.content.text).toContain("running");
    }
  });
});

describe("mapEngineEventToAcp — skipped events", () => {
  test("returns undefined for turn_start", () => {
    const event: EngineEvent = { kind: "turn_start", turnIndex: 0 };
    expect(mapEngineEventToAcp(event)).toBeUndefined();
  });

  test("returns undefined for turn_end", () => {
    const event: EngineEvent = { kind: "turn_end", turnIndex: 0 };
    expect(mapEngineEventToAcp(event)).toBeUndefined();
  });

  test("returns undefined for done", () => {
    const event: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "completed",
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 100 },
      },
    };
    expect(mapEngineEventToAcp(event)).toBeUndefined();
  });
});
