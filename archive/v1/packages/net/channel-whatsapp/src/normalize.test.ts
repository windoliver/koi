import { describe, expect, test } from "bun:test";
import { createNormalizer } from "./normalize.js";
import { createMockWAMessage } from "./test-helpers.js";

describe("createNormalizer", () => {
  const OWN_JID = "1234567890@s.whatsapp.net";
  const normalize = createNormalizer(OWN_JID);

  describe("text messages", () => {
    test("normalizes conversation text", () => {
      const msg = createMockWAMessage({ message: { conversation: "hello world" } });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result).not.toBeNull();
      expect(result?.content).toEqual([{ kind: "text", text: "hello world" }]);
      expect(result?.senderId).toBe("5511999999999@s.whatsapp.net");
      expect(result?.threadId).toBe("5511999999999@s.whatsapp.net");
    });

    test("normalizes extended text message", () => {
      const msg = createMockWAMessage({
        message: { extendedTextMessage: { text: "extended text" } },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content).toEqual([{ kind: "text", text: "extended text" }]);
    });
  });

  describe("self-filtering", () => {
    test("returns null for own messages", () => {
      const msg = createMockWAMessage({ fromMe: true });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result).toBeNull();
    });

    test("returns null for status broadcasts", () => {
      const msg = createMockWAMessage();
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "status@broadcast",
      });

      expect(result).toBeNull();
    });
  });

  describe("media messages", () => {
    test("normalizes image message", () => {
      const msg = createMockWAMessage({
        message: {
          imageMessage: {
            url: "https://example.com/img.jpg",
            mimetype: "image/jpeg",
            caption: "a photo",
          },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content[0]).toEqual({
        kind: "image",
        url: "https://example.com/img.jpg",
        alt: "a photo",
      });
    });

    test("normalizes document message", () => {
      const msg = createMockWAMessage({
        message: {
          documentMessage: {
            url: "https://example.com/doc.pdf",
            mimetype: "application/pdf",
            title: "report.pdf",
          },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content[0]).toEqual({
        kind: "file",
        url: "https://example.com/doc.pdf",
        mimeType: "application/pdf",
        name: "report.pdf",
      });
    });

    test("normalizes voice note as audio/ogg with opus codec", () => {
      const msg = createMockWAMessage({
        message: {
          audioMessage: { url: "https://example.com/voice.ogg", ptt: true },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content[0]).toEqual({
        kind: "file",
        url: "https://example.com/voice.ogg",
        mimeType: "audio/ogg; codecs=opus",
      });
    });

    test("normalizes regular audio message", () => {
      const msg = createMockWAMessage({
        message: {
          audioMessage: { url: "https://example.com/song.mp3", mimetype: "audio/mpeg", ptt: false },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content[0]).toEqual({
        kind: "file",
        url: "https://example.com/song.mp3",
        mimeType: "audio/mpeg",
      });
    });

    test("normalizes video message", () => {
      const msg = createMockWAMessage({
        message: {
          videoMessage: { url: "https://example.com/video.mp4", mimetype: "video/mp4" },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content[0]).toEqual({
        kind: "file",
        url: "https://example.com/video.mp4",
        mimeType: "video/mp4",
      });
    });

    test("normalizes sticker as custom block", () => {
      const msg = createMockWAMessage({
        message: {
          stickerMessage: { url: "https://example.com/sticker.webp", isAnimated: true },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content[0]).toEqual({
        kind: "custom",
        type: "whatsapp:sticker",
        data: { url: "https://example.com/sticker.webp", isAnimated: true },
      });
    });
  });

  describe("reactions", () => {
    test("normalizes reaction event", () => {
      const msg = createMockWAMessage();
      const result = normalize({
        kind: "reaction",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
        reaction: { text: "👍", key: { remoteJid: "5511999999999@s.whatsapp.net", id: "MSG001" } },
      });

      expect(result?.content[0]).toEqual({
        kind: "custom",
        type: "whatsapp:reaction",
        data: { emoji: "👍", targetMessageId: "MSG001" },
      });
    });

    test("returns null for own reaction", () => {
      const msg = createMockWAMessage({ fromMe: true });
      const result = normalize({
        kind: "reaction",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
        reaction: { text: "👍" },
      });

      expect(result).toBeNull();
    });
  });

  describe("ephemeral and view-once unwrapping", () => {
    test("unwraps ephemeral message", () => {
      const msg = createMockWAMessage({
        message: {
          ephemeralMessage: {
            message: { conversation: "disappearing text" },
          },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content).toEqual([{ kind: "text", text: "disappearing text" }]);
    });

    test("unwraps viewOnce message", () => {
      const msg = createMockWAMessage({
        message: {
          viewOnceMessage: {
            message: {
              imageMessage: {
                url: "https://example.com/once.jpg",
                mimetype: "image/jpeg",
              },
            },
          },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content[0]).toEqual({
        kind: "image",
        url: "https://example.com/once.jpg",
      });
    });

    test("unwraps viewOnceV2 message", () => {
      const msg = createMockWAMessage({
        message: {
          viewOnceMessageV2: {
            message: { conversation: "view once v2 text" },
          },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content).toEqual([{ kind: "text", text: "view once v2 text" }]);
    });

    test("unwraps nested ephemeral+viewOnce", () => {
      const msg = createMockWAMessage({
        message: {
          ephemeralMessage: {
            message: {
              viewOnceMessage: {
                message: { conversation: "deeply nested" },
              },
            },
          },
        },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result?.content).toEqual([{ kind: "text", text: "deeply nested" }]);
    });
  });

  describe("edge cases", () => {
    test("returns null for null message content", () => {
      const msg = createMockWAMessage({ message: null });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result).toBeNull();
    });

    test("returns null for empty message content", () => {
      const msg = createMockWAMessage({ message: {} });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result).toBeNull();
    });

    test("uses participant JID in group chats", () => {
      const msg = createMockWAMessage({
        remoteJid: "group@g.us",
        participant: "5511888888888@s.whatsapp.net",
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "group@g.us",
      });

      expect(result?.senderId).toBe("5511888888888@s.whatsapp.net");
    });

    test("handles bigint timestamp", () => {
      const msg = createMockWAMessage({ messageTimestamp: 1234567890 });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      // Baileys timestamps are in seconds, so multiplied by 1000
      expect(result?.timestamp).toBe(1234567890000);
    });

    test("skips image without url", () => {
      const msg = createMockWAMessage({
        message: { imageMessage: { url: null } },
      });
      const result = normalize({
        kind: "message",
        message: msg,
        chatJid: "5511999999999@s.whatsapp.net",
      });

      expect(result).toBeNull();
    });
  });
});
