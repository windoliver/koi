/**
 * Webhook ingestion: HTTP server that converts POST requests
 * into GatewayFrames dispatched through the gateway pipeline.
 */

import type { KoiError, Result } from "@koi/core";
import type { GatewayFrame, RoutingContext, Session } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Default max body size: 1 MB. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

export interface WebhookConfig {
  readonly port: number;
  readonly pathPrefix: string;
  /** Maximum request body size in bytes. Default: 1 MB. */
  readonly maxBodyBytes?: number;
}

export interface WebhookServer {
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly port: () => number;
}

export type WebhookDispatcher = (session: Session, frame: GatewayFrame) => void;

export type WebhookAuthenticator = (
  request: Request,
  rawBody: string,
) => Promise<Result<WebhookAuthResult, KoiError>>;

export interface WebhookAuthResult {
  readonly agentId: string;
  readonly routing?: RoutingContext;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebhookServer(
  config: WebhookConfig,
  dispatcher: WebhookDispatcher,
  authenticator?: WebhookAuthenticator,
): WebhookServer {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let resolvedPort: number = config.port;
  let frameCounter = 0;

  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  function nextFrameId(): string {
    return `wh-${crypto.randomUUID().slice(0, 8)}-${frameCounter++}`;
  }

  const prefix = config.pathPrefix.endsWith("/")
    ? config.pathPrefix.slice(0, -1)
    : config.pathPrefix;

  return {
    async start(): Promise<void> {
      server = Bun.serve({
        port: config.port,
        async fetch(request: Request): Promise<Response> {
          // POST only
          if (request.method !== "POST") {
            return jsonResponse(405, { ok: false, error: "Method not allowed" });
          }

          // Path check — require exact match or "/" boundary to avoid
          // "/webhook" matching "/webhookadmin"
          const url = new URL(request.url);
          if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
            return jsonResponse(404, { ok: false, error: "Not found" });
          }

          // Reject bodies that declare a too-large Content-Length early
          const declaredLength = request.headers.get("Content-Length");
          if (declaredLength !== null && parseInt(declaredLength, 10) > maxBodyBytes) {
            return jsonResponse(413, { ok: false, error: "Payload too large" });
          }

          // Extract channel/account from path: {prefix}/{channel}/{account?}
          const pathAfterPrefix = url.pathname.slice(prefix.length);
          const segments = pathAfterPrefix.split("/").filter((s) => s.length > 0);
          const channel = segments[0] ?? undefined;
          const account = segments[1] ?? undefined;

          // Extract peer from header
          const peer = request.headers.get("X-Webhook-Peer") ?? "webhook";

          // Read body with streaming size enforcement to prevent
          // unbounded memory consumption when Content-Length is absent
          let rawBody = "";
          try {
            if (request.body !== null) {
              const reader = request.body.getReader();
              const decoder = new TextDecoder();
              let totalBytes = 0;

              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                totalBytes += value.byteLength;
                if (totalBytes > maxBodyBytes) {
                  reader.cancel();
                  return jsonResponse(413, { ok: false, error: "Payload too large" });
                }
                rawBody += decoder.decode(value, { stream: true });
              }
              // Flush the decoder
              rawBody += decoder.decode();
            }
          } catch {
            return jsonResponse(400, { ok: false, error: "Failed to read request body" });
          }

          // Parse JSON body
          let payload: unknown = null;
          if (rawBody.length > 0) {
            try {
              payload = JSON.parse(rawBody);
            } catch {
              return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
            }
          }

          // Authenticate if authenticator provided — receives raw body
          // so it can verify HMAC signatures
          let agentId = "webhook";
          let routing: RoutingContext = {
            ...(channel !== undefined ? { channel } : {}),
            ...(account !== undefined ? { account } : {}),
            peer,
          };
          let metadata: Readonly<Record<string, unknown>> = {};

          if (authenticator !== undefined) {
            const authResult = await authenticator(request, rawBody);
            if (!authResult.ok) {
              return jsonResponse(401, { ok: false, error: authResult.error.message });
            }
            agentId = authResult.value.agentId;
            routing = authResult.value.routing ?? routing;
            metadata = authResult.value.metadata ?? metadata;
          }

          // Build virtual session + frame
          const frameId = nextFrameId();

          const session: Session = {
            id: `webhook-${frameId}`,
            agentId,
            connectedAt: Date.now(),
            lastHeartbeat: Date.now(),
            seq: 0,
            remoteSeq: 0,
            metadata,
            routing,
          };

          const frame: GatewayFrame = {
            kind: "event",
            id: frameId,
            seq: 0,
            timestamp: Date.now(),
            payload,
          };

          dispatcher(session, frame);

          return jsonResponse(200, { ok: true, frameId });
        },
      });
      resolvedPort = server.port ?? config.port;
    },

    stop(): void {
      server?.stop(true);
      server = undefined;
    },

    port(): number {
      return resolvedPort;
    },
  };
}
