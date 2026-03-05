/**
 * Test helpers for @koi/channel-slack.
 *
 * Provides mock factories for Slack WebClient and SocketModeClient
 * to enable unit testing without network calls.
 */

import { mock } from "bun:test";
import type { SlackMessageEvent } from "./normalize.js";

// ---------------------------------------------------------------------------
// Mock WebClient
// ---------------------------------------------------------------------------

export interface MockPostMessageArgs {
  readonly channel: string;
  readonly text?: string;
  readonly blocks?: readonly Record<string, unknown>[];
  readonly thread_ts?: string;
  readonly _authTest?: boolean;
}

export interface MockWebClient {
  readonly chat: {
    readonly postMessage: ReturnType<
      typeof mock<(args: Record<string, unknown>) => Promise<unknown>>
    >;
  };
}

/** Failure mode configuration for mock WebClient. */
export interface MockWebClientOptions {
  /** When true, postMessage rejects with an error. */
  readonly failOnSend?: boolean;
  /** When set, the Nth postMessage call (1-based) rejects with a rate_limited error. */
  readonly rateLimitOnNthCall?: number;
  /** Custom error message for failOnSend. */
  readonly sendErrorMessage?: string;
}

export function createMockWebClient(options?: MockWebClientOptions): MockWebClient {
  // let justified: tracks call count for rateLimitOnNthCall
  let callCount = 0;
  return {
    chat: {
      postMessage: mock(async (_args: Record<string, unknown>) => {
        callCount++;
        if (options?.failOnSend === true) {
          throw new Error(options.sendErrorMessage ?? "not_authed");
        }
        if (options?.rateLimitOnNthCall !== undefined && callCount === options.rateLimitOnNthCall) {
          throw new Error("rate_limited");
        }
        return { ok: true, ts: "1234567890.123456" };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Mock SocketModeClient
// ---------------------------------------------------------------------------

export interface MockSocketClient {
  readonly start: ReturnType<typeof mock<() => Promise<void>>>;
  readonly disconnect: ReturnType<typeof mock<() => Promise<void>>>;
  readonly on: (event: string, listener: (...args: readonly unknown[]) => void) => void;
  readonly removeAllListeners: ReturnType<typeof mock<() => void>>;
  /** Fires a registered event for testing. */
  readonly _emit: (event: string, payload: unknown) => void;
}

/** Failure mode configuration for mock SocketModeClient. */
export interface MockSocketClientOptions {
  /** When true, start() rejects with an error. */
  readonly throwOnConnect?: boolean;
}

export function createMockSocketClient(options?: MockSocketClientOptions): MockSocketClient {
  const listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>();

  return {
    start: mock(async () => {
      if (options?.throwOnConnect === true) {
        throw new Error("websocket_connect_failed");
      }
    }),
    disconnect: mock(async () => {}),
    on: (event: string, listener: (...args: readonly unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, [...existing, listener]);
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
// Mock Slack events
// ---------------------------------------------------------------------------

/** Allows undefined values to omit optional fields from the mock (for exactOptionalPropertyTypes). */
type MockOverrides<T> = { readonly [K in keyof T]?: T[K] | undefined };

export function createMockMessageEvent(
  overrides?: MockOverrides<SlackMessageEvent>,
): SlackMessageEvent {
  const defaults: SlackMessageEvent = {
    type: "message",
    text: "hello",
    user: "U123",
    channel: "C456",
    ts: "1234567890.000001",
  };

  if (overrides === undefined) {
    return defaults;
  }

  // Build result by omitting keys whose override value is undefined
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(overrides) as readonly (keyof SlackMessageEvent)[]) {
    const value = overrides[key];
    if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result as unknown as SlackMessageEvent;
}

export function createMockSlashCommand(
  overrides?: Partial<{
    readonly command: string;
    readonly text: string;
    readonly user_id: string;
    readonly channel_id: string;
    readonly trigger_id: string;
    readonly response_url: string;
  }>,
): Record<string, unknown> {
  return {
    command: "/test",
    text: "",
    user_id: "U123",
    channel_id: "C456",
    trigger_id: "T789",
    response_url: "https://hooks.slack.com/response/xxx",
    ...overrides,
  };
}
