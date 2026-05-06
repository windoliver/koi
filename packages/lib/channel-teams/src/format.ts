/**
 * @koi/channel-teams — OutboundMessage → Bot Framework activity payload.
 *
 * v1 keeps this minimal: text blocks become a `type: "message"` payload with
 * `text` joined by blank lines. Non-text blocks (image/file/buttons/audio/
 * video) fail closed with `UNSUPPORTED_BLOCK` until a real Bot Framework
 * attachment / suggested-action serializer is wired in. Silently dropping
 * them is a contract break: callers see `send()` resolve, the user sees a
 * partial / blank message on the wire, and there is no operator signal.
 * Capability flags in `teams-channel.ts` advertise text-only, so any caller
 * sending a non-text block is either bypassing the capability check or
 * holding stale capability data — both warrant a hard failure.
 */

import type { OutboundMessage } from "@koi/core";

export type ActivityPayload = {
  readonly type: "message";
  readonly text: string;
};

export type FormatError = {
  readonly code: "UNSUPPORTED_BLOCK";
  readonly message: string;
  readonly context: { readonly kind: string };
};

export type FormatResult =
  | { readonly ok: true; readonly value: ActivityPayload }
  | { readonly ok: false; readonly error: FormatError };

export function formatOutbound(message: OutboundMessage): FormatResult {
  const texts: string[] = [];
  for (const b of message.content) {
    if (b.kind === "text") {
      texts.push(b.text);
      continue;
    }
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_BLOCK",
        message: `Teams outbound does not support content block "${b.kind}" (only "text" is wired). Capability flags advertise text-only — sender should check capabilities.images/files/buttons before including non-text blocks.`,
        context: { kind: b.kind },
      },
    };
  }
  return { ok: true, value: { type: "message", text: texts.join("\n\n") } };
}
