import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { mapBlocksToAguiEvents } from "./event-map.js";

describe("mapBlocksToAguiEvents", () => {
  test("text block produces TEXT_MESSAGE_START + CONTENT + END", () => {
    const events = mapBlocksToAguiEvents([{ kind: "text", text: "Hello!" }], "msg-1");

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: EventType.TEXT_MESSAGE_START, messageId: "msg-1" });
    expect(events[1]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "Hello!",
    });
    expect(events[2]).toMatchObject({ type: EventType.TEXT_MESSAGE_END, messageId: "msg-1" });
  });

  test("multiple text blocks each produce their own START+CONTENT+END triplet", () => {
    const events = mapBlocksToAguiEvents(
      [
        { kind: "text", text: "Part 1" },
        { kind: "text", text: "Part 2" },
      ],
      "msg-2",
    );

    expect(events).toHaveLength(6);
    expect(events[0]).toMatchObject({ type: EventType.TEXT_MESSAGE_START });
    expect(events[1]).toMatchObject({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "Part 1" });
    expect(events[2]).toMatchObject({ type: EventType.TEXT_MESSAGE_END });
    expect(events[3]).toMatchObject({ type: EventType.TEXT_MESSAGE_START });
    expect(events[4]).toMatchObject({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "Part 2" });
    expect(events[5]).toMatchObject({ type: EventType.TEXT_MESSAGE_END });
  });

  test("image block produces CUSTOM event with koi:image name", () => {
    const events = mapBlocksToAguiEvents(
      [{ kind: "image", url: "https://example.com/img.png", alt: "A cat" }],
      "msg-3",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "koi:image",
      value: { url: "https://example.com/img.png", alt: "A cat" },
    });
  });

  test("file block produces CUSTOM event with koi:file name", () => {
    const events = mapBlocksToAguiEvents(
      [
        {
          kind: "file",
          url: "https://example.com/doc.pdf",
          mimeType: "application/pdf",
          name: "doc.pdf",
        },
      ],
      "msg-4",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "koi:file",
      value: { url: "https://example.com/doc.pdf", mimeType: "application/pdf", name: "doc.pdf" },
    });
  });

  test("button block produces CUSTOM event with koi:button name", () => {
    const events = mapBlocksToAguiEvents(
      [{ kind: "button", label: "Approve", action: "approve", payload: { id: "42" } }],
      "msg-5",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "koi:button",
      value: { label: "Approve", action: "approve", payload: { id: "42" } },
    });
  });

  test("custom block uses block.type as the CUSTOM event name", () => {
    const events = mapBlocksToAguiEvents(
      [{ kind: "custom", type: "myapp:card", data: { title: "Hello" } }],
      "msg-6",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "myapp:card",
      value: { title: "Hello" },
    });
  });

  test("empty blocks array returns empty events array", () => {
    expect(mapBlocksToAguiEvents([], "msg-7")).toHaveLength(0);
  });

  test("mixed blocks produce correct event sequence", () => {
    const events = mapBlocksToAguiEvents(
      [
        { kind: "text", text: "Here is an image:" },
        { kind: "image", url: "https://example.com/photo.jpg" },
      ],
      "msg-8",
    );

    expect(events).toHaveLength(4); // 3 text events + 1 custom
    expect(events[0]).toMatchObject({ type: EventType.TEXT_MESSAGE_START });
    expect(events[1]).toMatchObject({ type: EventType.TEXT_MESSAGE_CONTENT });
    expect(events[2]).toMatchObject({ type: EventType.TEXT_MESSAGE_END });
    expect(events[3]).toMatchObject({ type: EventType.CUSTOM, name: "koi:image" });
  });

  test("koi:state custom block type is forwarded as-is", () => {
    const events = mapBlocksToAguiEvents(
      [{ kind: "custom", type: "koi:state", data: { counter: 5 } }],
      "msg-9",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: EventType.CUSTOM, name: "koi:state" });
  });
});
