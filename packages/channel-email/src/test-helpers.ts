/**
 * Test helpers for @koi/channel-email.
 *
 * Provides mock factories for ImapFlow client and Nodemailer transporter
 * to enable unit testing without real IMAP/SMTP connections.
 */

import { mock } from "bun:test";
import type { ParsedEmail } from "./normalize.js";

// ---------------------------------------------------------------------------
// Mock IMAP Client
// ---------------------------------------------------------------------------

export interface MockImapClient {
  readonly connect: ReturnType<typeof mock<() => Promise<void>>>;
  readonly logout: ReturnType<typeof mock<() => Promise<void>>>;
  readonly getMailboxLock: ReturnType<
    typeof mock<(mailbox: string) => Promise<{ release: () => void }>>
  >;
  readonly idle: ReturnType<typeof mock<() => Promise<void>>>;
  readonly fetchOne: ReturnType<
    typeof mock<(seq: string, query: Record<string, unknown>) => Promise<{ source: Buffer }>>
  >;
  readonly on: (event: string, handler: (...args: readonly unknown[]) => void) => void;
  readonly removeAllListeners: ReturnType<typeof mock<() => void>>;
  /** Fires a registered event for testing. */
  readonly _emit: (event: string, payload: unknown) => void;
}

export function createMockImapClient(): MockImapClient {
  const listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>();
  const releaseFn = mock(() => {});

  return {
    connect: mock(async () => {}),
    logout: mock(async () => {}),
    getMailboxLock: mock(async (_mailbox: string) => ({ release: releaseFn })),
    idle: mock(async () => {}),
    fetchOne: mock(async (_seq: string, _query: Record<string, unknown>) => ({
      source: Buffer.from(""),
    })),
    on: (event: string, handler: (...args: readonly unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, [...existing, handler]);
    },
    removeAllListeners: mock(() => {
      listeners.clear();
    }),
    _emit: (event: string, payload: unknown) => {
      const fns = listeners.get(event) ?? [];
      for (const fn of fns) {
        fn(payload);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Nodemailer Transporter
// ---------------------------------------------------------------------------

export interface MockTransporter {
  readonly sendMail: ReturnType<
    typeof mock<(options: Record<string, unknown>) => Promise<unknown>>
  >;
  readonly close: ReturnType<typeof mock<() => void>>;
  readonly calls: Record<string, unknown>[];
}

export function createMockTransporter(): MockTransporter {
  const calls: Record<string, unknown>[] = [];
  return {
    sendMail: mock(async (options: Record<string, unknown>) => {
      calls.push(options);
      return { messageId: "<test@example.com>" };
    }),
    close: mock(() => {}),
    calls,
  };
}

// ---------------------------------------------------------------------------
// Mock ParsedEmail factory
// ---------------------------------------------------------------------------

/** Allows undefined values to omit optional fields from the mock (for exactOptionalPropertyTypes). */
type MockOverrides<T> = { readonly [K in keyof T]?: T[K] | undefined };

export function createMockParsedEmail(overrides?: MockOverrides<ParsedEmail>): ParsedEmail {
  const defaults: ParsedEmail = {
    messageId: "<msg001@example.com>",
    from: { value: [{ address: "sender@example.com", name: "Sender" }] },
    to: { value: [{ address: "bot@example.com", name: "Bot" }] },
    subject: "Test Subject",
    text: "Hello from email",
    date: new Date("2024-01-01T00:00:00Z"),
  };

  if (overrides === undefined) {
    return defaults;
  }

  // Build result by omitting keys whose override value is undefined
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(overrides) as readonly (keyof ParsedEmail)[]) {
    const value = overrides[key];
    if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result as unknown as ParsedEmail;
}
