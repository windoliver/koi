import { describe, expect, test } from "bun:test";
import { normalizeWhatsApp, type WhatsAppMessage } from "./normalize.js";

const PNID = "pn-1";
const clock = (): number => 9_999_999;

const textMessage: WhatsAppMessage = {
  id: "wamid.ABC",
  from: "15551234567",
  timestamp: "1700000000",
  type: "text",
  text: { body: "hello" },
};

describe("normalizeWhatsApp", () => {
  test("threadId scopes by business number (cross-number isolation)", () => {
    // Regression: previously threadId was the sender phone alone, so
    // the same end user reaching two distinct WhatsApp business
    // numbers landed in the same runtime thread and reply context
    // could bleed across numbers. Composite phoneNumberId|fromPhone
    // keeps conversations isolated per business number.
    const a = normalizeWhatsApp(textMessage, "pn-A", clock);
    const b = normalizeWhatsApp(textMessage, "pn-B", clock);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(a.value.threadId).toBe("pn-A|15551234567");
    expect(b.value.threadId).toBe("pn-B|15551234567");
    expect(a.value.threadId).not.toBe(b.value.threadId);
  });

  test("text message happy path", () => {
    const r = normalizeWhatsApp(textMessage, PNID, clock);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.content).toEqual([{ kind: "text", text: "hello" }]);
    expect(r.value.senderId).toBe("15551234567");
    // Composite threadId scopes the conversation by business number.
    expect(r.value.threadId).toBe(`${PNID}|15551234567`);
    expect(r.value.timestamp).toBe(1_700_000_000_000);
    expect(r.value.metadata?.wamid).toBe("wamid.ABC");
    expect(r.value.metadata?.phoneNumberId).toBe(PNID);
    expect(r.value.metadata?.recipientPhone).toBe("15551234567");
  });

  test("image with caption emits image block + text caption", () => {
    const r = normalizeWhatsApp(
      {
        id: "w1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "image",
        image: { id: "media-1", mime_type: "image/png", caption: "see this" },
      },
      PNID,
      clock,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.content).toEqual([
      { kind: "image", url: "<media:media-1>" },
      { kind: "text", text: "see this" },
    ]);
  });

  test("image without caption emits only image block", () => {
    const r = normalizeWhatsApp(
      {
        id: "w1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "image",
        image: { id: "media-1", mime_type: "image/png" },
      },
      PNID,
      clock,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.content).toEqual([{ kind: "image", url: "<media:media-1>" }]);
  });

  test("document with filename emits file block with name", () => {
    const r = normalizeWhatsApp(
      {
        id: "w1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "document",
        document: { id: "doc-1", mime_type: "application/pdf", filename: "rpt.pdf" },
      },
      PNID,
      clock,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.content).toEqual([
      { kind: "file", url: "<media:doc-1>", mimeType: "application/pdf", name: "rpt.pdf" },
    ]);
  });

  test("audio emits file block", () => {
    const r = normalizeWhatsApp(
      {
        id: "w1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "audio",
        audio: { id: "aud-1", mime_type: "audio/ogg" },
      },
      PNID,
      clock,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.content).toEqual([
      { kind: "file", url: "<media:aud-1>", mimeType: "audio/ogg" },
    ]);
  });

  test("location emits custom block", () => {
    const r = normalizeWhatsApp(
      {
        id: "w1",
        from: "15551234567",
        timestamp: "1700000000",
        type: "location",
      },
      PNID,
      clock,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const block = r.value.content[0];
    if (block === undefined || block.kind !== "custom") throw new Error("unreachable");
    expect(block.type).toBe("whatsapp/location");
  });

  test("context.message_id surfaces in metadata", () => {
    const r = normalizeWhatsApp(
      { ...textMessage, context: { message_id: "wamid.parent" } },
      PNID,
      clock,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.metadata?.contextMessageId).toBe("wamid.parent");
  });

  test("missing from rejected", () => {
    const r = normalizeWhatsApp({ ...textMessage, from: "" }, PNID, clock);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("INVALID_PAYLOAD");
  });

  test("missing id rejected", () => {
    const r = normalizeWhatsApp({ ...textMessage, id: "" }, PNID, clock);
    expect(r.ok).toBe(false);
  });

  test("invalid timestamp falls back to clock()", () => {
    const r = normalizeWhatsApp({ ...textMessage, timestamp: "not-a-number" }, PNID, clock);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.timestamp).toBe(9_999_999);
  });
});
