/**
 * WebSocket frame types for mobile channel communication.
 *
 * All frames are JSON-serialized and discriminated by `kind`.
 */

import type { ContentBlock } from "@koi/core";

/** Inbound frames sent from mobile client to server. */
export type MobileInboundFrame =
  | {
      readonly kind: "message";
      readonly content: readonly ContentBlock[];
      readonly senderId: string;
      readonly threadId?: string;
    }
  | { readonly kind: "tool_result"; readonly toolCallId: string; readonly result: unknown }
  | { readonly kind: "ping" }
  | { readonly kind: "auth"; readonly token: string };

/** Outbound frames sent from server to mobile client. */
export type MobileOutboundFrame =
  | { readonly kind: "message"; readonly content: readonly ContentBlock[] }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | { readonly kind: "pong" }
  | { readonly kind: "error"; readonly message: string };
