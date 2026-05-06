import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  InMemoryIdempotencyStore,
  InMemoryIngressQueue,
  InMemoryOutboxStore,
  InMemoryThreadStore,
} from "@koi/channel-base";
import type { InboundMessage, OutboundMessage } from "@koi/core";
import type { EmailConfig } from "./config.js";
import {
  createEmailChannel,
  type EmailChannelAdapter,
  type EmailDependencies,
  type ImapClient,
  type InboundEnvelope,
} from "./email-channel.js";
import type { MimeParser, ParsedMail } from "./normalize-bridge.js";
import type { SmtpEnvelope, SmtpSendResult, SmtpTransport } from "./platform-send.js";

function makeConfig(): EmailConfig {
  return {
    imap: {
      host: "imap.test",
      port: 993,
      user: "u",
      pass: "p",
      mailbox: "INBOX",
      tls: true,
    },
    smtp: {
      host: "smtp.test",
      port: 587,
      user: "u",
      pass: "p",
      from: "agent@test.local",
      tls: true,
    },
    pollInterval: 60_000,
    autoRetryAfterDataAck: false,
    production: false,
    handlerTimeoutMs: 5_000,
    commitTtlMs: 60_000,
  };
}

function makeFakeImap(): ImapClient & {
  emit(env: InboundEnvelope): void;
  readonly state: { opened: boolean; closed: boolean };
} {
  const subs: Array<(env: InboundEnvelope) => Promise<void>> = [];
  const state = { opened: false, closed: false };
  return {
    state,
    async open() {
      state.opened = true;
    },
    async close() {
      state.closed = true;
    },
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

function makeParser(messageId = "<inbound@test>"): MimeParser {
  return {
    async parse(): Promise<ParsedMail> {
      return {
        messageId,
        from: { value: [{ address: "user@test.local" }] },
        subject: "hello",
        text: "hello world",
        references: [],
      };
    },
  };
}

function makeSmtp(): SmtpTransport {
  return {
    async sendMail(env: SmtpEnvelope): Promise<SmtpSendResult> {
      return { accepted: env.to.slice(), rejected: [], response: "250 OK" };
    },
  };
}

function buildDeps(overrides: Partial<EmailDependencies> = {}): EmailDependencies {
  const ingressQueue = new InMemoryIngressQueue<InboundEnvelope, InboundMessage>();
  return {
    imap: overrides.imap ?? makeFakeImap(),
    smtp: overrides.smtp ?? makeSmtp(),
    parser: overrides.parser ?? makeParser(),
    threadStore: overrides.threadStore ?? new InMemoryThreadStore(),
    outboxStore: overrides.outboxStore ?? new InMemoryOutboxStore(),
    idempotencyStore: overrides.idempotencyStore ?? new InMemoryIdempotencyStore(),
    ingressQueue: overrides.ingressQueue ?? ingressQueue,
    ...(overrides.idGenerator ? { idGenerator: overrides.idGenerator } : {}),
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  };
}

async function tick(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("createEmailChannel", () => {
  let adapter: EmailChannelAdapter | null = null;

  beforeEach(() => {
    adapter = null;
  });
  afterEach(async () => {
    if (adapter) await adapter.disconnect();
  });

  test("returns adapter with required methods", () => {
    const deps = buildDeps();
    adapter = createEmailChannel(makeConfig(), deps);
    expect(adapter.name).toBe("email");
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
    expect(typeof adapter.send).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.getPendingSends).toBe("function");
    expect(typeof adapter.resolvePending).toBe("function");
  });

  test("connect opens IMAP; disconnect closes it", async () => {
    const imap = makeFakeImap();
    const deps = buildDeps({ imap });
    adapter = createEmailChannel(makeConfig(), deps);
    await adapter.connect();
    expect(imap.state.opened).toBe(true);
    await adapter.disconnect();
    expect(imap.state.closed).toBe(true);
  });

  test("inbound flows from IMAP → handler", async () => {
    const imap = makeFakeImap();
    const deps = buildDeps({ imap });
    adapter = createEmailChannel(makeConfig(), deps);
    const received: InboundMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    await adapter.connect();
    imap.emit({ raw: new Uint8Array([1]), uidValidity: 1, uid: 100 });
    await tick(400);
    expect(received.length).toBe(1);
    expect(received[0]?.senderId).toBe("user@test.local");
  });

  test("IMAP UID dedupe: same UIDVALIDITY+UID delivered twice → handler fires once", async () => {
    const imap = makeFakeImap();
    const deps = buildDeps({ imap });
    adapter = createEmailChannel(makeConfig(), deps);
    let count = 0;
    adapter.onMessage(async () => {
      count++;
    });
    await adapter.connect();
    imap.emit({ raw: new Uint8Array([1]), uidValidity: 1, uid: 100 });
    await tick(300);
    imap.emit({ raw: new Uint8Array([1]), uidValidity: 1, uid: 100 });
    await tick(300);
    expect(count).toBe(1);
  });

  test("send() succeeds and returns void", async () => {
    const deps = buildDeps();
    adapter = createEmailChannel(makeConfig(), deps);
    const out: OutboundMessage = {
      content: [{ kind: "text", text: "hi" }],
      threadId: "<thr@test>",
      metadata: { to: ["user@test.local"], subject: "hi" },
    };
    const r = await adapter.send(out);
    expect(r).toBeUndefined();
    const list = await deps.outboxStore.list({ status: "sent" });
    expect(list.length).toBe(1);
  });

  test("send() throws on THREAD_BLOCKED_PENDING_RECOVERY", async () => {
    const outboxStore = new InMemoryOutboxStore();
    await outboxStore.put({
      messageId: "<stuck@test>",
      threadKey: "<thr@test>",
      threadVersion: 1,
      payloadHash: "x",
      status: "awaiting-recovery",
      createdAt: 0,
    });
    const deps = buildDeps({ outboxStore });
    adapter = createEmailChannel(makeConfig(), deps);
    const out: OutboundMessage = {
      content: [{ kind: "text", text: "hi" }],
      threadId: "<thr@test>",
      metadata: { to: ["user@test.local"], subject: "hi" },
    };
    await expect(adapter.send(out)).rejects.toThrow(/THREAD_BLOCKED_PENDING_RECOVERY/);
  });
});
