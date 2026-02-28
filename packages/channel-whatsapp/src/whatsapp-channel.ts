/**
 * @koi/channel-whatsapp — Baileys WhatsApp Web channel adapter.
 *
 * Creates a ChannelAdapter for WhatsApp using @whiskeysockets/baileys.
 * Supports text, images, documents, audio, video, stickers, and reactions.
 *
 * Usage:
 *   const adapter = createWhatsAppChannel({
 *     authStatePath: "./auth_state",
 *     onQrCode: (qr) => console.log(qr),
 *   });
 *   await adapter.connect();
 *
 * threadId convention: chat JID (e.g., "5511999999999@s.whatsapp.net" or group JID)
 */

import { createChannelAdapter, createMediaFallback } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, ChannelStatus } from "@koi/core";
import type { WhatsAppChannelConfig } from "./config.js";
import type { WAMessage, WhatsAppEvent } from "./normalize.js";
import { createNormalizer } from "./normalize.js";
import type { WASocketApi } from "./platform-send.js";
import { whatsappSend } from "./platform-send.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: true,
  video: true,
  threads: false,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

// ---------------------------------------------------------------------------
// Extended adapter interface
// ---------------------------------------------------------------------------

/** ChannelAdapter for WhatsApp (no additional methods for now). */
export type WhatsAppChannelAdapter = ChannelAdapter;

// ---------------------------------------------------------------------------
// Types for injected or real socket
// ---------------------------------------------------------------------------

interface BaileysSocketLike {
  readonly ev: {
    readonly on: (event: string, handler: (...args: readonly unknown[]) => void) => void;
    readonly removeAllListeners: () => void;
  };
  readonly sendMessage: (jid: string, content: Record<string, unknown>) => Promise<unknown>;
  readonly end: (reason?: unknown) => void;
  readonly user?: { readonly id?: string } | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a WhatsApp ChannelAdapter.
 *
 * @param config - Auth state path, QR callback, and optional hooks.
 * @returns A WhatsAppChannelAdapter satisfying the @koi/core ChannelAdapter contract.
 */
export function createWhatsAppChannel(config: WhatsAppChannelConfig): WhatsAppChannelAdapter {
  const socket = (config._socket ?? null) as BaileysSocketLike | null;

  // let justified: actual socket instance, created during connect if not injected
  let activeSocket: BaileysSocketLike | null = socket;

  // let justified: own JID determined after connection
  let ownJid = "unknown";

  const api: WASocketApi = {
    sendMessage: async (jid: string, content: Record<string, unknown>) => {
      if (activeSocket === null) {
        throw new Error("[channel-whatsapp] Cannot send: not connected");
      }
      return activeSocket.sendMessage(jid, content);
    },
  };

  const platformSendStatus = async (status: ChannelStatus): Promise<void> => {
    if (status.kind !== "processing" || status.messageRef === undefined) {
      return;
    }
    // WhatsApp supports "composing" presence but Baileys implementation
    // varies. Skip for now — typing indicators are optional.
  };

  return createChannelAdapter<WhatsAppEvent>({
    name: "whatsapp",
    capabilities: WHATSAPP_CAPABILITIES,

    platformConnect: async () => {
      if (activeSocket === null) {
        activeSocket = await createBaileysSocket(config);
      }
      ownJid = activeSocket.user?.id ?? "unknown";
    },

    platformDisconnect: async () => {
      if (activeSocket !== null) {
        activeSocket.ev.removeAllListeners();
        activeSocket.end();
        activeSocket = null;
      }
    },

    platformSend: createMediaFallback({
      send: async (message) => {
        await whatsappSend(api, message);
      },
      ...(config.mediaMaxMb !== undefined ? { mediaMaxMb: config.mediaMaxMb } : {}),
    }),

    onPlatformEvent: (handler) => {
      if (activeSocket === null) {
        return () => {};
      }

      const sock = activeSocket;

      sock.ev.on("messages.upsert", (rawEvent: unknown) => {
        const event = rawEvent as {
          readonly messages: readonly WAMessage[];
          readonly type: string;
        };
        if (event.type !== "notify") return;

        for (const msg of event.messages) {
          const chatJid = msg.key.remoteJid;
          if (chatJid === null || chatJid === undefined) continue;

          // Check for reaction
          if (msg.message?.reactionMessage !== null && msg.message?.reactionMessage !== undefined) {
            handler({
              kind: "reaction",
              message: msg,
              chatJid,
              reaction: msg.message.reactionMessage,
            });
          } else {
            handler({ kind: "message", message: msg, chatJid });
          }
        }
      });

      sock.ev.on("connection.update", (rawUpdate: unknown) => {
        const update = rawUpdate as {
          readonly connection?: string;
          readonly qr?: string;
        };
        if (update.qr !== undefined && config.onQrCode !== undefined) {
          config.onQrCode(update.qr);
        }
      });

      return () => {
        sock.ev.removeAllListeners();
      };
    },

    normalize: (event: WhatsAppEvent) => createNormalizer(ownJid)(event),
    platformSendStatus,
    ...(config.onHandlerError !== undefined ? { onHandlerError: config.onHandlerError } : {}),
    ...(config.queueWhenDisconnected !== undefined
      ? { queueWhenDisconnected: config.queueWhenDisconnected }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Socket constructor (production only)
// ---------------------------------------------------------------------------

async function createBaileysSocket(config: WhatsAppChannelConfig): Promise<BaileysSocketLike> {
  const baileys = require("@whiskeysockets/baileys") as {
    readonly default: (opts: Record<string, unknown>) => BaileysSocketLike;
    readonly useMultiFileAuthState: (
      path: string,
    ) => Promise<{ readonly state: unknown; readonly saveCreds: () => Promise<void> }>;
  };

  const { state, saveCreds } = await baileys.useMultiFileAuthState(config.authStatePath);

  const sock = baileys.default({
    auth: state,
    printQRInTerminal: config.onQrCode === undefined,
  });

  sock.ev.on("creds.update", () => {
    void saveCreds();
  });

  return sock;
}
