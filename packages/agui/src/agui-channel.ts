/**
 * @koi/agui — AG-UI channel adapter.
 *
 * Implements the Koi ChannelAdapter contract over the AG-UI protocol (HTTP + SSE).
 * Each POST request from the CopilotKit frontend represents a complete agent run:
 *
 *   POST /agent  { threadId, runId, messages, state, tools, context }
 *     → SSE stream: RUN_STARTED → STATE_SNAPSHOT({}) → [streaming events from middleware]
 *                → [TEXT_MESSAGE events if no middleware] → RUN_FINISHED / RUN_ERROR
 *
 * Usage (standalone — owns its own Bun.serve):
 *   const { channel, middleware } = createAguiChannel({ port: 3000 });
 *
 * Usage (embedded — integrates into existing Bun.serve):
 *   const { handler, middleware } = createAguiHandler({ path: "/api/agent" });
 *   Bun.serve({ fetch: (req) => handler(req) ?? myHandler(req) });
 *
 * Companion middleware:
 *   Include the returned middleware in your agent's middleware stack to enable
 *   real-time token streaming (TEXT_MESSAGE_CONTENT deltas) and tool call
 *   visibility (TOOL_CALL_START/ARGS/END/RESULT).
 */

import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventType, RunAgentInputSchema } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { createChannelAdapter } from "@koi/channel-base";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundMessage,
  KoiMiddleware,
  MessageHandler,
  OutboundMessage,
} from "@koi/core";
import { createAguiStreamMiddleware } from "./agui-middleware.js";
import { mapBlocksToAguiEvents } from "./event-map.js";
import type { NormalizationMode } from "./normalize.js";
import { normalizeRunAgentInput } from "./normalize.js";
import type { RunContextStore } from "./run-context-store.js";
import { createRunContextStore } from "./run-context-store.js";

// Reuse a single encoder instance — EventEncoder with no args is stateless
// (acceptsProtobuf = false, so encodeSSE always returns data:...\n\n).
const SSE_ENCODER = new EventEncoder();

// Bun TextEncoder for converting SSE strings → Uint8Array for the WritableStream.
const TEXT_ENCODER = new TextEncoder();

export interface AguiChannelConfig {
  /**
   * TCP port to listen on when using standalone mode.
   * Ignored when using createAguiHandler().
   */
  readonly port?: number;

  /**
   * URL path that accepts AG-UI POST requests.
   * @default "/agent"
   */
  readonly path?: string;

  /**
   * History normalization mode.
   * - "stateful"  (default): only last user message dispatched
   * - "stateless": full message history flattened into content blocks
   */
  readonly mode?: NormalizationMode;

  /**
   * Called when a registered message handler throws or rejects.
   * Defaults to console.error.
   */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
}

export interface AguiChannelResult {
  /** ChannelAdapter to register in your Koi agent. */
  readonly channel: ChannelAdapter;
  /**
   * Companion KoiMiddleware that intercepts model/tool streams and emits
   * AG-UI SSE events in real time. Include this in your agent's middleware
   * stack for token-level streaming.
   */
  readonly middleware: KoiMiddleware;
  /**
   * The RunContextStore shared between the channel and middleware.
   * Exposed for testing and advanced observability use cases.
   */
  readonly store: RunContextStore;
}

export interface AguiHandlerResult {
  /**
   * HTTP request handler. Wire this into Bun.serve's fetch:
   *   fetch: (req) => handler(req) ?? fallback(req)
   *
   * Returns a Response for requests matching the configured path,
   * or null for all other paths.
   */
  readonly handler: (req: Request) => Promise<Response | null>;
  /** Same as AguiChannelResult.middleware. */
  readonly middleware: KoiMiddleware;
  /** Same as AguiChannelResult.store. */
  readonly store: RunContextStore;
  /**
   * Register a Koi engine message handler. Returns an unsubscribe function.
   * Wire this into your Koi agent assembly via channel.onMessage.
   *
   * @example
   * ```typescript
   * const { handler, onMessage } = createAguiHandler({ path: "/agent" });
   * onMessage(async (msg) => { await engine.dispatch(msg); });
   * ```
   */
  readonly onMessage: (handler: MessageHandler) => () => void;
}

const AGUI_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
} as const satisfies ChannelCapabilities;

/** Encode a BaseEvent as UTF-8 SSE bytes. */
function encodeEvent(event: BaseEvent): Uint8Array {
  return TEXT_ENCODER.encode(SSE_ENCODER.encodeSSE(event));
}

/**
 * Write an AG-UI event to an SSE stream.
 * Swallows write errors (stream may already be closed on client disconnect).
 */
async function writeEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  event: BaseEvent,
): Promise<void> {
  try {
    await writer.write(encodeEvent(event));
  } catch {
    // Client disconnected — no-op. The AbortSignal handler will clean up the store.
  }
}

/**
 * Handle a single AG-UI POST request and return an SSE Response.
 * This is the core logic used by both standalone and embedded modes.
 *
 * Exported for testing and custom integration scenarios where callers
 * need to inject a specific dispatch function.
 */
export async function handleAguiRequest(
  req: Request,
  store: RunContextStore,
  mode: NormalizationMode,
  dispatch: (message: InboundMessage) => Promise<void>,
): Promise<Response> {
  // Parse and validate the request body.
  let input: RunAgentInput;
  try {
    const body: unknown = await req.json();
    input = RunAgentInputSchema.parse(body);
  } catch (e: unknown) {
    return new Response(JSON.stringify({ error: "Invalid RunAgentInput", detail: String(e) }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const { runId, threadId } = input;

  // Normalize the AG-UI input into a Koi InboundMessage.
  const message = normalizeRunAgentInput(input, mode);
  if (message === null) {
    return new Response(JSON.stringify({ error: "No processable user message in RunAgentInput" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Create the SSE response stream with bounded backpressure.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 }), // ~16 KB
    new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 }),
  );
  const writer = writable.getWriter();

  // Use the request's abort signal for connection-drop cleanup.
  const signal = req.signal;
  store.register(runId, writer, signal);

  // Emit run lifecycle start events immediately.
  await writeEvent(writer, {
    type: EventType.RUN_STARTED,
    threadId,
    runId,
  });
  await writeEvent(writer, {
    type: EventType.STATE_SNAPSHOT,
    snapshot: {},
  });

  // Dispatch to the Koi engine asynchronously — the SSE stream stays open
  // while the engine runs. Do not await: the response is returned first so
  // the client starts receiving the SSE stream.
  void dispatch(message)
    .then(async () => {
      // Engine completed normally. If the channel's send() hasn't already
      // closed the stream (i.e., no OutboundMessage was sent), emit RUN_FINISHED
      // here as a safety net.
      const w = store.get(runId);
      if (w !== undefined) {
        await writeEvent(w, { type: EventType.RUN_FINISHED, threadId, runId });
        store.deregister(runId);
        try {
          await w.close();
        } catch {
          // already closed
        }
      }
    })
    .catch(async (e: unknown) => {
      const w = store.get(runId);
      if (w !== undefined) {
        await writeEvent(w, {
          type: EventType.RUN_ERROR,
          message: e instanceof Error ? e.message : String(e),
        });
        store.deregister(runId);
        try {
          await w.close();
        } catch {
          // already closed
        }
      }
    });

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/**
 * Create an AG-UI channel that embeds into an existing Bun.serve fetch handler.
 *
 * @example
 * ```typescript
 * const { handler, middleware } = createAguiHandler({ path: "/api/agent" });
 * Bun.serve({
 *   fetch: async (req) => (await handler(req)) ?? new Response("Not Found", { status: 404 }),
 * });
 * ```
 */
export function createAguiHandler(config: AguiChannelConfig = {}): AguiHandlerResult {
  const { path = "/agent", mode = "stateful" } = config;
  const store = createRunContextStore();
  const middleware = createAguiStreamMiddleware({ store });

  // let requires justification: handlers registered/unregistered via onMessage()
  let msgHandlers: readonly MessageHandler[] = [];

  const handler = async (req: Request): Promise<Response | null> => {
    if (req.method !== "POST" || new URL(req.url).pathname !== path) {
      return null;
    }
    return handleAguiRequest(req, store, mode, async (msg) => {
      const results = await Promise.allSettled(msgHandlers.map((h) => h(msg)));
      const firstRejected = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (firstRejected !== undefined) throw firstRejected.reason;
    });
  };

  const onMessage = (msgHandler: MessageHandler): (() => void) => {
    msgHandlers = [...msgHandlers, msgHandler];
    return () => {
      msgHandlers = msgHandlers.filter((h) => h !== msgHandler);
    };
  };

  return { handler, middleware, store, onMessage };
}

/**
 * Create an AG-UI channel adapter with its own Bun HTTP server.
 *
 * Returns both a ChannelAdapter (for Koi agent configuration) and a companion
 * KoiMiddleware (for token streaming). Wire both into your agent:
 *
 * @example
 * ```typescript
 * const { channel, middleware } = createAguiChannel({ port: 3000 });
 * const agent = await createKoi({
 *   manifest,
 *   channels: [channel],
 *   middleware: [middleware],
 * });
 * ```
 */
export function createAguiChannel(config: AguiChannelConfig = {}): AguiChannelResult {
  const { port = 3000, path = "/agent", mode = "stateful" } = config;
  const store = createRunContextStore();
  const middleware = createAguiStreamMiddleware({ store });

  // let requires justification: handlers registered/unregistered via channel.onMessage()
  let awaitableHandlers: readonly MessageHandler[] = [];

  type RawEvent = InboundMessage;

  const base = createChannelAdapter<RawEvent>({
    name: "agui",
    capabilities: AGUI_CAPABILITIES,

    platformConnect: async () => {
      // Server is started in onPlatformEvent — not here.
      // Bun.serve requires the fetch handler to be registered at startup.
    },

    platformDisconnect: async () => {
      // Bun.serve stop() is called inside disconnect().
      // Since createChannelAdapter doesn't expose a server handle, we use a
      // module-level ref captured at creation time.
      serverRef?.stop(true);
      serverRef = undefined;
    },

    platformSend: async (message: OutboundMessage) => {
      const runId = message.metadata?.runId as string | undefined;
      if (runId === undefined) {
        // No runId — cannot route. This happens if send() is called outside
        // of an active AG-UI run (e.g., from a non-HTTP trigger).
        console.warn("[agui] send() called without metadata.runId — message dropped");
        return;
      }

      const writer = store.get(runId);
      if (writer === undefined) {
        // Connection was dropped before the agent could respond.
        return;
      }

      const threadId = message.threadId ?? runId;

      // If the middleware has not already streamed text, emit full TEXT events.
      if (!store.hasTextStreamed(runId)) {
        const textEvents = mapBlocksToAguiEvents(message.content, `${runId}-final`);
        for (const event of textEvents) {
          await writeEvent(writer, event);
        }
      }

      // Emit STATE_DELTA for koi:state custom blocks, if any.
      for (const block of message.content) {
        if (block.kind === "custom" && block.type === "koi:state") {
          await writeEvent(writer, {
            type: EventType.STATE_DELTA,
            delta: block.data,
          });
        }
      }

      // Finalize the run.
      await writeEvent(writer, { type: EventType.RUN_FINISHED, threadId, runId });
      store.deregister(runId);
      try {
        await writer.close();
      } catch {
        // already closed
      }
    },

    onPlatformEvent: (_) => {
      // Start the Bun server. Dispatch is handled via awaitableHandlers so
      // the engine's message handler completes before RUN_FINISHED is emitted.
      serverRef = Bun.serve({
        port,
        fetch: async (req) => {
          if (req.method !== "POST" || new URL(req.url).pathname !== path) {
            return new Response("Not Found", { status: 404 });
          }
          return handleAguiRequest(req, store, mode, async (msg) => {
            const results = await Promise.allSettled(awaitableHandlers.map((h) => h(msg)));
            const firstRejected = results.find(
              (r): r is PromiseRejectedResult => r.status === "rejected",
            );
            if (firstRejected !== undefined) throw firstRejected.reason;
          });
        },
      });

      return () => {
        serverRef?.stop(true);
        serverRef = undefined;
      };
    },

    normalize: (event: RawEvent) => event,

    ...(config.onHandlerError !== undefined && { onHandlerError: config.onHandlerError }),
  });

  // let requires justification: Bun server handle acquired in onPlatformEvent,
  // released in disconnect() / onPlatformEvent unsubscribe.
  let serverRef: ReturnType<typeof Bun.serve> | undefined;

  // Overlay onMessage so registering a handler also adds it to awaitableHandlers.
  // This ensures the HTTP dispatch path can await engine completion before
  // handleAguiRequest emits RUN_FINISHED.
  const channel: ChannelAdapter = {
    ...base,
    onMessage: (msgHandler: MessageHandler) => {
      awaitableHandlers = [...awaitableHandlers, msgHandler];
      const unsub = base.onMessage(msgHandler);
      return () => {
        awaitableHandlers = awaitableHandlers.filter((h) => h !== msgHandler);
        unsub();
      };
    },
  };

  return { channel, middleware, store };
}

/**
 * For testing: collect all AG-UI events streamed to the handler for a given
 * RunAgentInput. Returns the decoded events in order.
 */
export async function captureAguiEvents(
  handler: (req: Request) => Promise<Response | null>,
  input: RunAgentInput,
  path = "/agent",
): Promise<readonly BaseEvent[]> {
  const body = JSON.stringify(input);
  const ac = new AbortController();
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    signal: ac.signal,
  });

  const response = await handler(req);
  if (response === null || !response.ok || response.body === null) {
    return [];
  }

  const events: BaseEvent[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // let requires justification: partial line buffer across ReadableStream chunks
  let buffer = "";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are delimited by \n\n
    const frames = buffer.split("\n\n");
    // The last element may be an incomplete frame
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      // Each frame is "data: <json>"
      const dataLine = frame.trim();
      if (!dataLine.startsWith("data: ")) {
        continue;
      }
      const json = dataLine.slice("data: ".length);
      try {
        events.push(JSON.parse(json) as BaseEvent);
      } catch {
        // malformed frame — skip
      }
    }

    // Stop reading after RUN_FINISHED or RUN_ERROR
    const last = events.at(-1);
    if (
      last !== undefined &&
      (last.type === EventType.RUN_FINISHED || last.type === EventType.RUN_ERROR)
    ) {
      ac.abort();
      break;
    }
  }

  return events;
}
