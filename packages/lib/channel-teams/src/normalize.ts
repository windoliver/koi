/**
 * @koi/channel-teams — Bot Framework Activity → InboundMessage normalizer.
 *
 * Only `type === "message"` activities produce an InboundMessage. Other
 * activity kinds return INVALID_ACTIVITY (the caller may still 200 the
 * provider — that's a webhook decision, not a normalize concern).
 */

import type { ContentBlock, InboundMessage, JsonObject } from "@koi/core";

export type ActivityAttachment = {
  readonly contentType: string;
  readonly contentUrl?: string;
  readonly name?: string;
};

export type Activity = {
  readonly type: string;
  readonly id: string;
  readonly conversation: { readonly id: string; readonly tenantId?: string };
  readonly from: { readonly id: string; readonly name?: string };
  readonly serviceUrl: string;
  readonly channelId: string;
  readonly text?: string;
  readonly attachments?: readonly ActivityAttachment[];
  readonly timestamp?: string;
};

export type NormalizeError = { readonly code: "INVALID_ACTIVITY"; readonly message: string };

export type NormalizeResult =
  | { readonly ok: true; readonly value: InboundMessage }
  | { readonly ok: false; readonly error: NormalizeError };

export function normalizeActivity(activity: Activity, clock: () => number): NormalizeResult {
  if (activity.type !== "message") {
    return {
      ok: false,
      error: { code: "INVALID_ACTIVITY", message: `unsupported activity type: ${activity.type}` },
    };
  }
  const text = (activity.text ?? "").replace(/<at>.*?<\/at>\s*/g, "").trim();
  const blocks: readonly ContentBlock[] = text.length > 0 ? [{ kind: "text", text }] : [];

  const attachments = activity.attachments ?? [];
  const meta: JsonObject =
    attachments.length > 0
      ? {
          attachments: attachments.map((a) => ({
            contentType: a.contentType,
            ...(a.contentUrl !== undefined ? { contentUrl: a.contentUrl } : {}),
            ...(a.name !== undefined ? { name: a.name } : {}),
          })),
        }
      : {};

  const timestamp =
    typeof activity.timestamp === "string" ? Date.parse(activity.timestamp) || clock() : clock();

  const message: InboundMessage = {
    content: blocks,
    senderId: activity.from.id,
    threadId: activity.conversation.id,
    timestamp,
    metadata: meta,
  };
  return { ok: true, value: message };
}
