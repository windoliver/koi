/**
 * ACP protocol request handler for the server side.
 *
 * Handles inbound JSON-RPC requests from the IDE:
 * - `initialize` → validate protocol version, return agent capabilities
 * - `session/new` → create session context, return sessionId
 * - `session/prompt` → convert to Koi input, run agent, stream events
 * - `session/cancel` → abort active session via AbortController
 */

import type { AcpTransport, InitializeParams, RpcId } from "@koi/acp-protocol";
import {
  buildErrorResponse,
  buildResponse,
  mapAcpContentToKoi,
  mapEngineEventToAcp,
  RPC_ERROR_CODES,
} from "@koi/acp-protocol";
import type { EngineEvent, InboundMessage, MessageHandler } from "@koi/core";
import type { AcpServerConfig } from "./types.js";
import { ACP_PROTOCOL_VERSION } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionContext {
  readonly sessionId: string;
  readonly cwd: string;
}

export interface ProtocolState {
  /** Whether initialize has been completed. */
  readonly initialized: boolean;
  /** Current session context (set after session/new). */
  readonly session: SessionContext | undefined;
  /** Whether a session/prompt is currently active. */
  readonly prompting: boolean;
}

export interface ProtocolHandler {
  /** Handle an inbound initialize request. */
  readonly handleInitialize: (id: RpcId, params: unknown) => void;
  /** Handle an inbound session/new request. */
  readonly handleSessionNew: (id: RpcId, params: unknown) => void;
  /**
   * Handle an inbound session/prompt request.
   * Returns a promise that resolves when the prompt completes.
   */
  readonly handleSessionPrompt: (id: RpcId, params: unknown) => Promise<void>;
  /** Handle an inbound session/cancel request. */
  readonly handleSessionCancel: (id: RpcId) => void;
  /** Get the current protocol state. */
  readonly getState: () => ProtocolState;
  /** Set the message handler (called when a session/prompt arrives). */
  readonly setMessageHandler: (handler: MessageHandler) => void;
  /** Set the engine event streamer (called to stream events during a prompt). */
  readonly setEventStreamer: (
    streamer: (input: {
      readonly messages: readonly InboundMessage[];
      readonly signal: AbortSignal;
    }) => AsyncIterable<EngineEvent>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// let: counter for generating unique session IDs
let sessionCounter = 0;

export function createProtocolHandler(
  transport: AcpTransport,
  config: AcpServerConfig,
): ProtocolHandler {
  // let: protocol state
  let initialized = false;
  let session: SessionContext | undefined;
  let prompting = false;
  // let: abort controller for active prompt
  let promptController: AbortController | undefined;
  // let: message handler provided by the channel
  let messageHandler: MessageHandler | undefined;
  // let: engine event streamer
  let eventStreamer:
    | ((input: {
        readonly messages: readonly InboundMessage[];
        readonly signal: AbortSignal;
      }) => AsyncIterable<EngineEvent>)
    | undefined;

  function handleInitialize(id: RpcId, params: unknown): void {
    if (initialized) {
      transport.send(
        buildErrorResponse(id, RPC_ERROR_CODES.INVALID_REQUEST, "Already initialized"),
      );
      return;
    }

    const p = params as InitializeParams | undefined;
    if (p === undefined || typeof p !== "object" || typeof p.protocolVersion !== "number") {
      transport.send(
        buildErrorResponse(id, RPC_ERROR_CODES.INVALID_PARAMS, "Missing protocolVersion"),
      );
      return;
    }

    initialized = true;

    transport.send(
      buildResponse(id, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentInfo: config.agentInfo ?? { name: "@koi/acp", version: "0.0.0" },
        agentCapabilities: config.agentCapabilities ?? {},
      }),
    );
  }

  function handleSessionNew(id: RpcId, params: unknown): void {
    if (!initialized) {
      transport.send(buildErrorResponse(id, RPC_ERROR_CODES.INVALID_REQUEST, "Not initialized"));
      return;
    }

    const p = params as { readonly cwd?: string } | undefined;
    const cwd = typeof p?.cwd === "string" ? p.cwd : process.cwd();
    const sessionId = `sess_${++sessionCounter}`;

    session = { sessionId, cwd };

    transport.send(buildResponse(id, { sessionId }));
  }

  async function handleSessionPrompt(id: RpcId, params: unknown): Promise<void> {
    if (!initialized) {
      transport.send(buildErrorResponse(id, RPC_ERROR_CODES.INVALID_REQUEST, "Not initialized"));
      return;
    }

    if (session === undefined) {
      transport.send(buildErrorResponse(id, RPC_ERROR_CODES.INVALID_REQUEST, "No active session"));
      return;
    }

    if (prompting) {
      transport.send(
        buildErrorResponse(
          id,
          RPC_ERROR_CODES.INVALID_REQUEST,
          "A prompt is already active. Wait for it to complete or cancel it.",
        ),
      );
      return;
    }

    const p = params as
      | {
          readonly sessionId?: string;
          readonly prompt?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
        }
      | undefined;

    // Validate caller-provided sessionId matches the active session
    if (p?.sessionId !== undefined && p.sessionId !== session.sessionId) {
      transport.send(
        buildErrorResponse(
          id,
          RPC_ERROR_CODES.INVALID_REQUEST,
          `Session ID mismatch: expected ${session.sessionId}, got ${p.sessionId}`,
        ),
      );
      return;
    }

    if (p?.prompt === undefined || !Array.isArray(p.prompt)) {
      transport.send(
        buildErrorResponse(id, RPC_ERROR_CODES.INVALID_PARAMS, "Missing prompt content"),
      );
      return;
    }

    prompting = true;
    const controller = new AbortController();
    promptController = controller;

    const sessionId = session.sessionId;

    try {
      // Convert ACP content blocks to Koi content blocks
      const koiContent = mapAcpContentToKoi(
        p.prompt as ReadonlyArray<import("@koi/acp-protocol").ContentBlock>,
      );

      // Build InboundMessage
      const inbound: InboundMessage = {
        content: koiContent,
        senderId: "ide",
        timestamp: Date.now(),
      };

      // If we have a message handler, notify it (for L1 wiring)
      if (messageHandler !== undefined) {
        await messageHandler(inbound);
      }

      // Stream engine events to the IDE
      let stopReason: "end_turn" | "error" | "cancelled" = "end_turn";

      if (eventStreamer !== undefined) {
        try {
          for await (const event of eventStreamer({
            messages: [inbound],
            signal: controller.signal,
          })) {
            if (controller.signal.aborted) {
              stopReason = "cancelled";
              break;
            }

            // Map engine event to ACP session/update notification
            const update = mapEngineEventToAcp(event);
            if (update !== undefined) {
              const notification = JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: { sessionId, update },
              });
              transport.send(notification);
            }

            // Check for done event to extract stop reason
            if (event.kind === "done") {
              switch (event.output.stopReason) {
                case "completed":
                  stopReason = "end_turn";
                  break;
                case "error":
                  stopReason = "error";
                  break;
                case "interrupted":
                  stopReason = "cancelled";
                  break;
                case "max_turns":
                  stopReason = "end_turn";
                  break;
              }
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[acp] Engine stream error:", message);
          stopReason = "error";
        }
      }

      // Send session/prompt result
      transport.send(buildResponse(id, { stopReason }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      transport.send(buildErrorResponse(id, RPC_ERROR_CODES.INTERNAL_ERROR, message));
    } finally {
      prompting = false;
      promptController = undefined;
    }
  }

  function handleSessionCancel(id: RpcId): void {
    if (promptController !== undefined) {
      promptController.abort("session/cancel");
    }
    transport.send(buildResponse(id, {}));
  }

  return {
    handleInitialize,
    handleSessionNew,
    handleSessionPrompt,
    handleSessionCancel,

    getState: (): ProtocolState => ({
      initialized,
      session,
      prompting,
    }),

    setMessageHandler(handler: MessageHandler): void {
      messageHandler = handler;
    },

    setEventStreamer(
      streamer: (input: {
        readonly messages: readonly InboundMessage[];
        readonly signal: AbortSignal;
      }) => AsyncIterable<EngineEvent>,
    ): void {
      eventStreamer = streamer;
    },
  };
}
