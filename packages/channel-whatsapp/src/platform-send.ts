/**
 * WhatsApp outbound message sender.
 *
 * Converts OutboundMessage → Baileys send calls.
 * Handles text, images, documents, audio, video, and buttons.
 */

import { splitText } from "@koi/channel-base";
import type { ContentBlock, OutboundMessage } from "@koi/core";

/** WhatsApp text message limit (approximate safe limit). */
const TEXT_LIMIT = 4096;

/** Minimal interface for Baileys WASocket send methods. */
export interface WASocketApi {
  readonly sendMessage: (jid: string, content: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Sends an OutboundMessage via Baileys WASocket.
 */
export async function whatsappSend(socket: WASocketApi, message: OutboundMessage): Promise<void> {
  if (message.threadId === undefined) {
    return;
  }

  const jid = message.threadId;
  const chunks = buildChunks(message.content);

  for (const chunk of chunks) {
    await socket.sendMessage(jid, chunk);
  }
}

function buildChunks(blocks: readonly ContentBlock[]): readonly Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [];

  // let justified: accumulate adjacent text blocks
  let pendingText = "";

  const flushText = (): void => {
    if (pendingText.length === 0) return;
    const parts = splitText(pendingText, TEXT_LIMIT);
    for (const part of parts) {
      chunks.push({ text: part });
    }
    pendingText = "";
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "text":
        pendingText = pendingText.length > 0 ? `${pendingText}\n${block.text}` : block.text;
        break;
      case "image":
        flushText();
        chunks.push({
          image: { url: block.url },
          ...(block.alt !== undefined ? { caption: block.alt } : {}),
        });
        break;
      case "file":
        flushText();
        chunks.push({
          document: { url: block.url },
          mimetype: block.mimeType,
          ...(block.name !== undefined ? { fileName: block.name } : {}),
        });
        break;
      case "button": {
        flushText();
        chunks.push({
          text: block.label,
          buttons: [
            {
              buttonId: block.action,
              buttonText: { displayText: block.label },
              type: 1,
            },
          ],
        });
        break;
      }
      case "custom":
        // Silently skip custom blocks
        break;
    }
  }

  flushText();
  return chunks;
}
