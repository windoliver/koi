import { describe, expect, test } from "bun:test";
import {
  createNormalizer,
  type DiscordButtonInteractionLike,
  type DiscordMessageLike,
  type DiscordSlashCommandLike,
} from "./normalize.js";

const BOT = "BOT_USER_ID";

function msg(over: Partial<DiscordMessageLike> = {}): DiscordMessageLike {
  return {
    id: "m1",
    content: "hello",
    author: { id: "u1", bot: false },
    channelId: "C1",
    guildId: "G1",
    createdTimestamp: 1700000000000,
    attachments: new Map(),
    ...over,
  };
}

describe("@koi/channel-discord normalize", () => {
  test("returns null for bot's own message", () => {
    const n = createNormalizer(() => BOT);
    const out = n({
      kind: "message",
      message: msg({ author: { id: BOT, bot: true } }),
    });
    expect(out).toBeNull();
  });

  test("normalizes guild text message with threadId guildId:channelId", () => {
    const n = createNormalizer(() => BOT);
    const out = n({ kind: "message", message: msg() });
    expect(out).not.toBeNull();
    expect(out?.threadId).toBe("G1:C1");
    expect(out?.senderId).toBe("u1");
    expect(out?.content[0]).toEqual({ kind: "text", text: "hello" });
  });

  test("DM message uses dm:channelId threadId (round-trips with channels.cache)", () => {
    const n = createNormalizer(() => BOT);
    const out = n({ kind: "message", message: msg({ guildId: null, channelId: "DM_CHAN" }) });
    expect(out?.threadId).toBe("dm:DM_CHAN");
  });

  test("returns null when message has no content and no attachments", () => {
    const n = createNormalizer(() => BOT);
    const out = n({ kind: "message", message: msg({ content: "" }) });
    expect(out).toBeNull();
  });

  test("image attachment becomes an image block, file becomes a file block", () => {
    const atts = new Map();
    atts.set("a", { url: "https://x/img.png", name: "img.png", contentType: "image/png" });
    atts.set("b", { url: "https://x/doc.pdf", name: "doc.pdf", contentType: "application/pdf" });
    const n = createNormalizer(() => BOT);
    const out = n({ kind: "message", message: msg({ content: "", attachments: atts }) });
    expect(out?.content).toHaveLength(2);
    const kinds = out?.content.map((b) => b.kind);
    expect(kinds).toEqual(["image", "file"]);
  });

  test("slash_command produces a discord:slash_command custom block", () => {
    const cmd: DiscordSlashCommandLike = {
      kind: "slash_command",
      id: "i1",
      name: "say",
      options: [{ name: "text", value: "hi" }],
      userId: "u2",
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1700000000001,
    };
    const n = createNormalizer(() => BOT);
    const out = n({ kind: "slash_command", command: cmd });
    expect(out?.senderId).toBe("u2");
    expect(out?.threadId).toBe("G1:C1");
    expect(out?.content[0]).toEqual({
      kind: "custom",
      type: "discord:slash_command",
      data: { name: "say", options: [{ name: "text", value: "hi" }] },
    });
  });

  test("button interaction parses customId into action + JSON payload", () => {
    const btn: DiscordButtonInteractionLike = {
      kind: "button",
      id: "b1",
      customId: 'confirm:{"orderId":42}',
      userId: "u3",
      channelId: "C2",
      guildId: "G1",
      createdTimestamp: 1700000000002,
    };
    const n = createNormalizer(() => BOT);
    const out = n({ kind: "button", button: btn });
    expect(out?.content[0]).toEqual({
      kind: "button",
      label: "confirm",
      action: "confirm",
      payload: { orderId: 42 },
    });
  });

  test("button without ':' uses customId as bare action", () => {
    const btn: DiscordButtonInteractionLike = {
      kind: "button",
      id: "b2",
      customId: "cancel",
      userId: "u3",
      channelId: "C2",
      guildId: null,
      createdTimestamp: 1700000000003,
    };
    const n = createNormalizer(() => BOT);
    const out = n({ kind: "button", button: btn });
    expect(out?.threadId).toBe("dm:C2");
    expect(out?.content[0]).toEqual({ kind: "button", label: "cancel", action: "cancel" });
  });
});
