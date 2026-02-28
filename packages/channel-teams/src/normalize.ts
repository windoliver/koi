/**
 * Normalizes Teams Activity objects to InboundMessage.
 *
 * Handles message activities with text and attachments.
 * Returns null for non-message activities and bot self-messages.
 */

import type { MessageNormalizer } from "@koi/channel-base";
import { file, image, text } from "@koi/channel-base";
import type { ContentBlock, InboundMessage } from "@koi/core";
import type { TeamsActivity } from "./activity-types.js";

/**
 * Creates a normalizer that converts Teams Activity to InboundMessage.
 * Filters out bot's own messages and non-message activities.
 */
export function createNormalizer(appId: string): MessageNormalizer<TeamsActivity> {
  return (activity: TeamsActivity): InboundMessage | null => {
    // Only handle message activities
    if (activity.type !== "message") {
      return null;
    }

    // Filter out bot's own messages
    if (activity.from.id === appId) {
      return null;
    }

    const blocks: ContentBlock[] = [];

    // Extract text content
    if (activity.text !== undefined && activity.text.length > 0) {
      // Strip @mention of the bot from the text
      const cleanText = activity.text.replace(/<at>.*?<\/at>\s*/g, "").trim();
      if (cleanText.length > 0) {
        blocks.push(text(cleanText));
      }
    }

    // Extract attachments
    if (activity.attachments !== undefined) {
      for (const attachment of activity.attachments) {
        if (attachment.contentUrl !== undefined) {
          const contentType = attachment.contentType.toLowerCase();
          if (contentType.startsWith("image/")) {
            blocks.push(image(attachment.contentUrl, attachment.name));
          } else {
            blocks.push(
              file(attachment.contentUrl, attachment.contentType, attachment.name ?? undefined),
            );
          }
        }
      }
    }

    if (blocks.length === 0) {
      return null;
    }

    return {
      content: blocks,
      senderId: activity.from.id,
      threadId: activity.conversation.id,
      timestamp:
        activity.timestamp !== undefined ? new Date(activity.timestamp).getTime() : Date.now(),
    };
  };
}
