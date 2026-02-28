/**
 * Tests for ACP session/update → Koi EngineEvent mapping.
 */

import { describe, expect, test } from "bun:test";
import type { SessionUpdatePayload } from "./acp-schema.js";
import { mapSessionUpdate } from "./event-map.js";

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
