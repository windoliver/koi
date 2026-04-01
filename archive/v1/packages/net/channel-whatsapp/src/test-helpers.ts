/**
 * Test helpers for @koi/channel-whatsapp.
 *
 * Provides mock factory for Baileys WASocket to enable
 * unit testing without a real WhatsApp connection.
 */

import { mock } from "bun:test";
import type { WAMessage, WAMessageContent } from "./normalize.js";

// ---------------------------------------------------------------------------
// Mock WASocket
// ---------------------------------------------------------------------------

export interface MockBaileysSocket {
  readonly ev: {
    readonly on: (event: string, handler: (...args: readonly unknown[]) => void) => void;
    readonly removeAllListeners: ReturnType<typeof mock<() => void>>;
    /** Fires a registered event for testing. */
    readonly _emit: (event: string, payload: unknown) => void;
  };
  readonly sendMessage: ReturnType<
    typeof mock<(jid: string, content: Record<string, unknown>) => Promise<unknown>>
  >;
  readonly end: ReturnType<typeof mock<() => void>>;
  readonly user: { readonly id: string };
}

export function createMockBaileysSocket(
  overrides?: Partial<{ readonly userId: string }>,
): MockBaileysSocket {
  const listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>();

  return {
    ev: {
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
    },
    sendMessage: mock(async (_jid: string, _content: Record<string, unknown>) => ({})),
    end: mock(() => {}),
    user: { id: overrides?.userId ?? "1234567890@s.whatsapp.net" },
  };
}

// ---------------------------------------------------------------------------
// Mock WAMessage factory
// ---------------------------------------------------------------------------

export function createMockWAMessage(
  overrides?: Partial<{
    readonly remoteJid: string;
    readonly fromMe: boolean;
    readonly participant: string | null;
    readonly message: WAMessageContent | null;
    readonly messageTimestamp: number;
  }>,
): WAMessage {
  return {
    key: {
      remoteJid: overrides?.remoteJid ?? "5511999999999@s.whatsapp.net",
      fromMe: overrides?.fromMe ?? false,
      id: "MSG001",
      ...(overrides?.participant !== undefined ? { participant: overrides.participant } : {}),
    },
    message: overrides?.message !== undefined ? overrides.message : { conversation: "hello" },
    messageTimestamp: overrides?.messageTimestamp ?? 1234567890,
  };
}
