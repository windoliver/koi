import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createCanvasEvent, extractCanvasMessage, isCanvasEvent } from "./events.js";
import type { A2uiMessage } from "./types.js";
import { componentId, surfaceId } from "./types.js";

const sampleMessage: A2uiMessage = {
  kind: "createSurface",
  surfaceId: surfaceId("s1"),
  components: [{ id: componentId("c1"), type: "Text" }],
};

describe("createCanvasEvent", () => {
  test("wraps A2UI message as custom EngineEvent", () => {
    const event = createCanvasEvent(sampleMessage);
    expect(event.kind).toBe("custom");
    const custom = event as { readonly type: string; readonly data: unknown };
    expect(custom.type).toBe("a2ui:createSurface");
    expect(custom.data).toBe(sampleMessage);
  });

  test("uses message kind as event type suffix", () => {
    const deleteMsg: A2uiMessage = {
      kind: "deleteSurface",
      surfaceId: surfaceId("s1"),
    };
    const event = createCanvasEvent(deleteMsg);
    const custom = event as { readonly type: string };
    expect(custom.type).toBe("a2ui:deleteSurface");
  });
});

describe("isCanvasEvent", () => {
  test("returns true for a2ui: prefixed custom events", () => {
    const event = createCanvasEvent(sampleMessage);
    expect(isCanvasEvent(event)).toBe(true);
  });

  test("returns false for non-custom events", () => {
    const event: EngineEvent = { kind: "text_delta", delta: "hello" };
    expect(isCanvasEvent(event)).toBe(false);
  });

  test("returns false for custom events without a2ui prefix", () => {
    const event: EngineEvent = { kind: "custom", type: "other:event", data: {} };
    expect(isCanvasEvent(event)).toBe(false);
  });
});

describe("extractCanvasMessage", () => {
  test("extracts A2UI message from canvas event", () => {
    const event = createCanvasEvent(sampleMessage);
    const result = extractCanvasMessage(event);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("createSurface");
    }
  });

  test("returns error for non-custom event", () => {
    const event: EngineEvent = { kind: "text_delta", delta: "hi" };
    const result = extractCanvasMessage(event);
    expect(result.ok).toBe(false);
  });

  test("returns error for non-a2ui custom event", () => {
    const event: EngineEvent = { kind: "custom", type: "other", data: {} };
    const result = extractCanvasMessage(event);
    expect(result.ok).toBe(false);
  });

  test("returns error for invalid data shape", () => {
    const event: EngineEvent = { kind: "custom", type: "a2ui:foo", data: "not-object" };
    const result = extractCanvasMessage(event);
    expect(result.ok).toBe(false);
  });

  test("round-trips: message → event → message", () => {
    const event = createCanvasEvent(sampleMessage);
    const result = extractCanvasMessage(event);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(sampleMessage);
    }
  });
});
