import { describe, expect, test } from "bun:test";
import type { TeamsActivity } from "./activity-types.js";
import { createNormalizer } from "./normalize.js";

const APP_ID = "bot-app-id";
const normalize = createNormalizer(APP_ID);

function makeActivity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    id: "activity-1",
    text: "hello teams",
    from: { id: "user-1", name: "Test User" },
    conversation: { id: "conv-1" },
    ...overrides,
  };
}

describe("createNormalizer", () => {
  test("returns InboundMessage for text message activity", async () => {
    const result = await normalize(makeActivity());
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "text", text: "hello teams" }]);
    expect(result?.senderId).toBe("user-1");
    expect(result?.threadId).toBe("conv-1");
  });

  test("returns null for bot's own messages", async () => {
    const result = await normalize(makeActivity({ from: { id: APP_ID, name: "Bot" } }));
    expect(result).toBeNull();
  });

  test("returns null for non-message activities", async () => {
    const result = await normalize(makeActivity({ type: "conversationUpdate" }));
    expect(result).toBeNull();
  });

  test("strips @mention tags from text", async () => {
    const result = await normalize(makeActivity({ text: "<at>Bot</at> hello there" }));
    expect(result?.content).toEqual([{ kind: "text", text: "hello there" }]);
  });

  test("returns null when text is empty after stripping mentions", async () => {
    const result = await normalize(makeActivity({ text: "<at>Bot</at>" }));
    expect(result).toBeNull();
  });

  test("returns null for activity with no text and no attachments", async () => {
    const activity: TeamsActivity = {
      type: "message",
      id: "activity-1",
      from: { id: "user-1", name: "Test User" },
      conversation: { id: "conv-1" },
    };
    const result = await normalize(activity);
    expect(result).toBeNull();
  });

  test("handles image attachments", async () => {
    const activity: TeamsActivity = {
      type: "message",
      id: "activity-1",
      from: { id: "user-1", name: "Test User" },
      conversation: { id: "conv-1" },
      attachments: [
        {
          contentType: "image/png",
          contentUrl: "https://teams.example.com/image.png",
          name: "screenshot.png",
        },
      ],
    };
    const result = await normalize(activity);
    expect(result?.content[0]).toMatchObject({
      kind: "image",
      url: "https://teams.example.com/image.png",
    });
  });

  test("handles file attachments", async () => {
    const activity: TeamsActivity = {
      type: "message",
      id: "activity-1",
      from: { id: "user-1", name: "Test User" },
      conversation: { id: "conv-1" },
      attachments: [
        {
          contentType: "application/pdf",
          contentUrl: "https://teams.example.com/doc.pdf",
          name: "doc.pdf",
        },
      ],
    };
    const result = await normalize(activity);
    expect(result?.content[0]).toMatchObject({
      kind: "file",
      url: "https://teams.example.com/doc.pdf",
      mimeType: "application/pdf",
    });
  });

  test("combines text and attachments", async () => {
    const result = await normalize(
      makeActivity({
        text: "check this out",
        attachments: [
          {
            contentType: "image/jpeg",
            contentUrl: "https://teams.example.com/photo.jpg",
          },
        ],
      }),
    );
    expect(result?.content).toHaveLength(2);
    expect(result?.content[0]).toEqual({ kind: "text", text: "check this out" });
    expect(result?.content[1]).toMatchObject({ kind: "image" });
  });

  test("uses activity timestamp when available", async () => {
    const result = await normalize(makeActivity({ timestamp: "2024-01-01T00:00:00Z" }));
    expect(result?.timestamp).toBe(new Date("2024-01-01T00:00:00Z").getTime());
  });
});
