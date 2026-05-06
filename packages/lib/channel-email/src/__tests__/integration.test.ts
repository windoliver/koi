/**
 * @koi/channel-email — full lifecycle integration test.
 *
 * Wires the factory with all in-memory stores and fake transports, drives a
 * complete inbound → handler → outbound reply loop, and asserts the outbox
 * row reaches `sent` with correct In-Reply-To/References headers.
 */

import { describe, expect, test } from "bun:test";
import {
  InMemoryIdempotencyStore,
  InMemoryIngressQueue,
  InMemoryOutboxStore,
  InMemoryThreadStore,
} from "@koi/channel-base";
import type { InboundMessage, OutboundMessage } from "@koi/core";
import type { EmailConfig } from "../config.js";
import { createEmailChannel, type ImapClient, type InboundEnvelope } from "../email-channel.js";
import type { MimeParser, ParsedMail } from "../normalize-bridge.js";
import type { SmtpEnvelope, SmtpSendResult, SmtpTransport } from "../platform-send.js";

const CONFIG: EmailConfig = {
  imap: { host: "imap", port: 993, user: "u", pass: "p", mailbox: "INBOX", tls: true },
  smtp: { host: "smtp", port: 587, user: "u", pass: "p", from: "agent@test.local", tls: true },
  pollInterval: 60_000,
  autoRetryAfterDataAck: false,
  production: false,
  handlerTimeoutMs: 5_000,
  commitTtlMs: 60_000,
};

function fakeImap(): ImapClient & { emit(env: InboundEnvelope): void } {
  const subs: Array<(env: InboundEnvelope) => Promise<void>> = [];
  return {
    async open() {},
    async close() {},
    onNewMessage(cb) {
      subs.push(cb);
      return () => {
        const i = subs.indexOf(cb);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    emit(env) {
      for (const cb of subs.slice()) cb(env);
    },
  };
}

const SAMPLE_MESSAGE_ID = "<inbound-42@user.test>";

const fakeParser: MimeParser = {
  async parse(): Promise<ParsedMail> {
    return {
      messageId: SAMPLE_MESSAGE_ID,
      from: { value: [{ address: "user@user.test" }] },
      to: { value: [{ address: "agent@test.local" }] },
      subject: "Hello agent",
      text: "ping",
      references: [],
    };
  },
};

describe("integration: full email channel lifecycle", () => {
  test("connect → inbound → handler → reply → sent", async () => {
    const sentEnvelopes: SmtpEnvelope[] = [];
    const smtp: SmtpTransport = {
      async sendMail(env: SmtpEnvelope): Promise<SmtpSendResult> {
        sentEnvelopes.push(env);
        return { accepted: env.to.slice(), rejected: [], response: "250 OK" };
      },
    };
    const imap = fakeImap();
    const threadStore = new InMemoryThreadStore();
    const outboxStore = new InMemoryOutboxStore();
    const ingressQueue = new InMemoryIngressQueue<InboundEnvelope, InboundMessage>();
    const idempotencyStore = new InMemoryIdempotencyStore();

    const adapter = createEmailChannel(CONFIG, {
      imap,
      smtp,
      parser: fakeParser,
      threadStore,
      outboxStore,
      ingressQueue,
      idempotencyStore,
      idGenerator: () => "<reply-1@test.local>",
    });

    const inbound: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      inbound.push(msg);
      const reply: OutboundMessage = {
        content: [{ kind: "text", text: "pong" }],
        ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
        metadata: {
          to: [msg.senderId],
          subject: `re: ${typeof msg.metadata?.subject === "string" ? msg.metadata.subject : ""}`,
        },
      };
      // Pre-seed the thread chain with the inbound Message-ID so the reply
      // includes it in In-Reply-To/References.
      if (msg.threadId) {
        await threadStore.cas(msg.threadId, 0, { chain: [SAMPLE_MESSAGE_ID] });
      }
      await adapter.send(reply);
    });

    await adapter.connect();
    imap.emit({ raw: new Uint8Array([1, 2, 3]), uidValidity: 7, uid: 42 });

    // Wait for the worker to claim, dispatch handler, send reply, and ack.
    for (let i = 0; i < 30 && sentEnvelopes.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(inbound.length).toBe(1);
    expect(sentEnvelopes.length).toBe(1);
    const env = sentEnvelopes[0];
    if (!env) throw new Error("no envelope captured");
    expect(env.headers["In-Reply-To"]).toBe(SAMPLE_MESSAGE_ID);
    expect(env.headers.References).toContain(SAMPLE_MESSAGE_ID);
    expect(env.headers["Message-ID"]).toBe("<reply-1@test.local>");

    const sentRows = await outboxStore.list({ status: "sent" });
    expect(sentRows.length).toBe(1);

    await adapter.disconnect();
  });
});
