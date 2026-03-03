/**
 * Configuration types for @koi/channel-matrix.
 */

import type { InboundMessage } from "@koi/core";

/** Feature toggles for the Matrix channel. */
export interface MatrixFeatures {
  /** Enable thread support (room = thread). Default: true */
  readonly threads?: boolean;
  /** Enable reaction handling. Default: false */
  readonly reactions?: boolean;
  /** Enable end-to-end encryption. Default: false */
  readonly encryption?: boolean;
  /** Enable rich text (HTML) formatting in outbound messages. Default: true */
  readonly richText?: boolean;
}

/** Configuration for the Matrix channel adapter. */
export interface MatrixChannelConfig {
  /** Matrix homeserver URL (e.g., "https://matrix.org"). */
  readonly homeserverUrl: string;
  /** Bot access token from homeserver. */
  readonly accessToken: string;
  /** Path for simple filesystem storage. Default: "./matrix-storage" */
  readonly storagePath?: string;
  /** Auto-join rooms when invited. Default: true */
  readonly autoJoin?: boolean;
  /** Feature toggles. */
  readonly features?: MatrixFeatures;
  /** Debounce window for rapid messages in ms. Default: 500 */
  readonly debounceMs?: number;
  /** Error handler for message processing failures. */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /** Queue outbound messages when disconnected. Default: false */
  readonly queueWhenDisconnected?: boolean;
  /** @internal Test injection for MatrixClient. */
  readonly _client?: unknown;
}

/** Default debounce window in milliseconds. */
export const DEFAULT_MATRIX_DEBOUNCE_MS = 500;
