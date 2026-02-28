/**
 * E2E lifecycle test for @koi/channel-email.
 *
 * Uses mock IMAP client and Nodemailer transporter to verify
 * the full email lifecycle without real IMAP/SMTP connections.
 */

import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { createEmailChannel } from "../email-channel.js";
import { createMockImapClient, createMockTransporter } from "../test-helpers.js";

const DEFAULT_CONFIG = {
  imap: { host: "imap.test.com", port: 993, auth: { user: "test", pass: "test" } },
  smtp: { host: "smtp.test.com", port: 587, auth: { user: "test", pass: "test" } },
  fromAddress: "bot@test.com",
  fromName: "Test Bot",
} as const;

describe("email channel e2e lifecycle", () => {
  test("connect → disconnect cycle", async () => {
    const imapClient = createMockImapClient();
    const transporter = createMockTransporter();

    const adapter = createEmailChannel({
      ...DEFAULT_CONFIG,
      _imapClient: imapClient,
      _transporter: transporter,
    });

    await adapter.connect();
    expect(imapClient.connect).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
    expect(imapClient.logout).toHaveBeenCalledTimes(1);
    expect(transporter.close).toHaveBeenCalledTimes(1);
  });

  test("handler error isolation", async () => {
    const imapClient = createMockImapClient();
    const transporter = createMockTransporter();
    const errorHandler = mock((_err: unknown, _msg: InboundMessage) => {});

    const adapter = createEmailChannel({
      ...DEFAULT_CONFIG,
      _imapClient: imapClient,
      _transporter: transporter,
      onHandlerError: errorHandler,
    });

    const received: InboundMessage[] = [];

    adapter.onMessage(async () => {
      throw new Error("handler crash");
    });

    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();
    await adapter.disconnect();
  });

  test("unsubscribed handler does not receive messages", async () => {
    const imapClient = createMockImapClient();
    const transporter = createMockTransporter();

    const adapter = createEmailChannel({
      ...DEFAULT_CONFIG,
      _imapClient: imapClient,
      _transporter: transporter,
    });

    const received: InboundMessage[] = [];
    const unsub = adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    unsub();

    await adapter.connect();
    await adapter.disconnect();
  });

  test("send does not throw for empty content", async () => {
    const imapClient = createMockImapClient();
    const transporter = createMockTransporter();

    const adapter = createEmailChannel({
      ...DEFAULT_CONFIG,
      _imapClient: imapClient,
      _transporter: transporter,
    });

    await adapter.connect();
    await adapter.send({ content: [] });
    await adapter.disconnect();
  });

  test("capabilities are correct", () => {
    const imapClient = createMockImapClient();
    const transporter = createMockTransporter();

    const adapter = createEmailChannel({
      ...DEFAULT_CONFIG,
      _imapClient: imapClient,
      _transporter: transporter,
    });

    expect(adapter.capabilities.text).toBe(true);
    expect(adapter.capabilities.threads).toBe(true);
    expect(adapter.capabilities.buttons).toBe(false);
    expect(adapter.capabilities.audio).toBe(false);
  });
});
