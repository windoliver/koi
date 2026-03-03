import { describe, expect, test } from "bun:test";
import type { MatrixRoomEvent } from "./normalize.js";
import { createNormalizer } from "./normalize.js";

const BOT_USER_ID = "@bot:matrix.org";
const normalize = createNormalizer(BOT_USER_ID);

function makeEvent(overrides: Partial<MatrixRoomEvent> = {}): MatrixRoomEvent {
  return {
    type: "m.room.message",
    sender: "@user:matrix.org",
    event_id: "$event1",
    room_id: "!room1:matrix.org",
    content: {
      msgtype: "m.text",
      body: "hello",
    },
    ...overrides,
  };
}

describe("createNormalizer", () => {
  test("returns InboundMessage for m.text message", async () => {
    const result = await normalize(makeEvent());
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "text", text: "hello" }]);
    expect(result?.senderId).toBe("@user:matrix.org");
    expect(result?.threadId).toBe("!room1:matrix.org");
  });

  test("returns null for bot's own messages", async () => {
    const result = await normalize(makeEvent({ sender: BOT_USER_ID }));
    expect(result).toBeNull();
  });

  test("returns null for non-message events", async () => {
    const result = await normalize(makeEvent({ type: "m.room.member" }));
    expect(result).toBeNull();
  });

  test("handles m.notice as text", async () => {
    const result = await normalize(
      makeEvent({ content: { msgtype: "m.notice", body: "notice text" } }),
    );
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "text", text: "notice text" }]);
  });

  test("handles m.image with url", async () => {
    const result = await normalize(
      makeEvent({
        content: {
          msgtype: "m.image",
          body: "photo.jpg",
          url: "mxc://matrix.org/abc123",
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({
      kind: "image",
      url: "mxc://matrix.org/abc123",
    });
  });

  test("returns null for m.image without url", async () => {
    const result = await normalize(makeEvent({ content: { msgtype: "m.image", body: "no url" } }));
    expect(result).toBeNull();
  });

  test("handles m.file with url and mimetype", async () => {
    const result = await normalize(
      makeEvent({
        content: {
          msgtype: "m.file",
          body: "doc.pdf",
          url: "mxc://matrix.org/file1",
          info: { mimetype: "application/pdf" },
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.content[0]).toMatchObject({
      kind: "file",
      url: "mxc://matrix.org/file1",
      mimeType: "application/pdf",
    });
  });

  test("returns null for m.file without url", async () => {
    const result = await normalize(makeEvent({ content: { msgtype: "m.file", body: "no url" } }));
    expect(result).toBeNull();
  });

  test("returns null for empty text body", async () => {
    const result = await normalize(makeEvent({ content: { msgtype: "m.text", body: "" } }));
    expect(result).toBeNull();
  });

  test("returns null for unsupported msgtype", async () => {
    const result = await normalize(makeEvent({ content: { msgtype: "m.video", body: "video" } }));
    expect(result).toBeNull();
  });

  test("defaults file mimetype to application/octet-stream", async () => {
    const result = await normalize(
      makeEvent({
        content: {
          msgtype: "m.file",
          body: "unknown.bin",
          url: "mxc://matrix.org/file2",
        },
      }),
    );
    expect(result?.content[0]).toMatchObject({
      kind: "file",
      mimeType: "application/octet-stream",
    });
  });
});
