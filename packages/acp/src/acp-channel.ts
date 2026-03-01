/**
 * ACP server ChannelAdapter — main factory.
 *
 * `createAcpChannel()` implements the Koi `ChannelAdapter` contract for the
 * server side of ACP. An IDE spawns `koi serve --manifest koi.yaml` and
 * communicates via JSON-RPC 2.0 over stdin/stdout.
 *
 * Protocol flow:
 *   IDE → initialize → agent capabilities
 *   IDE → session/new → sessionId
 *   IDE → session/prompt → events (session/update notifications) → result
 *   IDE → session/cancel → abort active prompt
 *   stdin EOF → disconnect → cleanup
 */

import type { AcpTransport, RpcMessage } from "@koi/acp-protocol";
import { buildErrorResponse, mapKoiContentToAcp, RPC_ERROR_CODES } from "@koi/acp-protocol";
import type {
  ChannelCapabilities,
  ChannelStatus,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";
import { createApprovalHandler } from "./approval-bridge.js";
import { createProtocolHandler } from "./protocol-handler.js";
import { createRequestTracker } from "./request-tracker.js";
import { createProcessTransport } from "./server-transport.js";
import type { AcpChannelAdapter, AcpServerConfig } from "./types.js";
import { DEFAULT_BACKPRESSURE_LIMIT, DEFAULT_TIMEOUTS } from "./types.js";

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const ACP_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: false, // ACP uses base64, Koi uses URLs — lossy mapping
  files: true,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAcpChannel(config?: AcpServerConfig): AcpChannelAdapter {
  const resolvedConfig: AcpServerConfig = config ?? {};
  const resolvedTimeouts = {
    fsMs: resolvedConfig.timeouts?.fsMs ?? DEFAULT_TIMEOUTS.fsMs,
    terminalMs: resolvedConfig.timeouts?.terminalMs ?? DEFAULT_TIMEOUTS.terminalMs,
    permissionMs: resolvedConfig.timeouts?.permissionMs ?? DEFAULT_TIMEOUTS.permissionMs,
  };
  const backpressureLimit = resolvedConfig.backpressureLimit ?? DEFAULT_BACKPRESSURE_LIMIT;

  // let: transport and handler state
  let transport: AcpTransport | undefined;
  let tracker: ReturnType<typeof createRequestTracker> | undefined;
  let protocol: ReturnType<typeof createProtocolHandler> | undefined;
  // let: lifecycle flag
  let connected = false;
  // let: message handler
  let onMessageHandler: MessageHandler | undefined;
  // let: buffered events count for backpressure
  let bufferedEvents = 0;

  // ---------------------------------------------------------------------------
  // Receive loop — routes inbound JSON-RPC messages
  // ---------------------------------------------------------------------------

  async function runReceiveLoop(
    tr: AcpTransport,
    proto: ReturnType<typeof createProtocolHandler>,
    req: ReturnType<typeof createRequestTracker>,
  ): Promise<void> {
    try {
      for await (const msg of tr.receive()) {
        await routeMessage(msg, tr, proto, req);
      }
    } catch (error: unknown) {
      console.warn("[acp] Receive loop error:", error);
    }
  }

  async function routeMessage(
    msg: RpcMessage,
    tr: AcpTransport,
    proto: ReturnType<typeof createProtocolHandler>,
    req: ReturnType<typeof createRequestTracker>,
  ): Promise<void> {
    switch (msg.kind) {
      case "inbound_request": {
        switch (msg.method) {
          case "initialize":
            proto.handleInitialize(msg.id, msg.params);
            break;
          case "session/new":
            proto.handleSessionNew(msg.id, msg.params);
            break;
          case "session/prompt":
            // Run prompt asynchronously to not block the receive loop
            void proto.handleSessionPrompt(msg.id, msg.params);
            break;
          case "session/cancel":
            proto.handleSessionCancel(msg.id);
            break;
          default:
            tr.send(
              buildErrorResponse(
                msg.id,
                RPC_ERROR_CODES.METHOD_NOT_FOUND,
                `Method not found: ${msg.method}`,
              ),
            );
            break;
        }
        break;
      }

      case "success_response": {
        req.resolveResponse(msg.id, msg.result);
        break;
      }

      case "error_response": {
        req.rejectResponse(msg.id, msg.error);
        break;
      }

      case "notification": {
        // Server doesn't expect notifications from the IDE in normal flow.
        // Silently ignore.
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter implementation
  // ---------------------------------------------------------------------------

  async function connect(): Promise<void> {
    if (connected) return;

    transport = createProcessTransport();
    tracker = createRequestTracker(transport);
    protocol = createProtocolHandler(transport, resolvedConfig);

    // Wire the message handler into the protocol handler
    if (onMessageHandler !== undefined) {
      protocol.setMessageHandler(onMessageHandler);
    }

    connected = true;

    // Start the receive loop (runs until stdin closes)
    void runReceiveLoop(transport, protocol, tracker);
  }

  async function disconnect(): Promise<void> {
    if (!connected) return;
    connected = false;

    tracker?.rejectAll("Channel disconnecting");
    transport?.close();

    transport = undefined;
    tracker = undefined;
    protocol = undefined;
  }

  async function send(message: OutboundMessage): Promise<void> {
    if (transport === undefined || protocol === undefined) return;

    const state = protocol.getState();
    if (state.session === undefined) return;

    // Backpressure check
    if (bufferedEvents >= backpressureLimit) {
      // Skip sending — buffer is full
      return;
    }
    bufferedEvents++;

    // Convert Koi OutboundMessage to ACP session/update notification
    const acpContent = mapKoiContentToAcp(message.content);
    if (acpContent.length === 0) {
      bufferedEvents--;
      return;
    }

    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: state.session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: acpContent,
        },
      },
    });
    transport.send(notification);
    bufferedEvents--;
  }

  function onMessage(handler: MessageHandler): () => void {
    onMessageHandler = handler;
    if (protocol !== undefined) {
      protocol.setMessageHandler(handler);
    }
    return () => {
      onMessageHandler = undefined;
    };
  }

  async function sendStatus(status: ChannelStatus): Promise<void> {
    if (transport === undefined || protocol === undefined) return;

    const state = protocol.getState();
    if (state.session === undefined) return;

    // Map ChannelStatus to a custom session/update notification
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: state.session.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          mode: status.detail ?? status.kind,
        },
      },
    });
    transport.send(notification);
  }

  function getApprovalHandler(): import("@koi/core").ApprovalHandler {
    if (tracker === undefined) {
      throw new Error("[acp] Cannot create approval handler before connect()");
    }
    return createApprovalHandler(
      tracker,
      () => protocol?.getState().session?.sessionId,
      resolvedTimeouts.permissionMs,
    );
  }

  return {
    name: "acp",
    capabilities: ACP_CAPABILITIES,
    connect,
    disconnect,
    send,
    onMessage,
    sendStatus,
    getApprovalHandler,
  };
}
