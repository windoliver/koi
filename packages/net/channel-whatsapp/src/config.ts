/**
 * Configuration types for the WhatsApp channel adapter.
 */

import type { InboundMessage } from "@koi/core";

/** Configuration for the WhatsApp channel adapter. */
export interface WhatsAppChannelConfig {
  /** Path to store Baileys authentication state (session credentials). */
  readonly authStatePath: string;
  /** Callback invoked with QR code string for user to scan. */
  readonly onQrCode?: (qr: string) => void;
  /** Maximum media attachment size in MB. Oversized media triggers text fallback. */
  readonly mediaMaxMb?: number;
  /** Called when a registered message handler throws or rejects. */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /** When true, send() buffers messages while disconnected. */
  readonly queueWhenDisconnected?: boolean;
  /** Test injection: Baileys WASocket instance. */
  readonly _socket?: unknown;
}
