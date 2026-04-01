/**
 * Webhook ingestion: HTTP server that converts POST requests
 * into GatewayFrames dispatched through the gateway pipeline.
 */

import type { KoiError, Result } from "@koi/core";
import type { GatewayFrame, RoutingContext, Session } from "@koi/gateway-types";
import { jsonResponse, matchPath, parseJsonBody } from "./http-helpers.js";

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
          const pathResult = matchPath(url.pathname, prefix);
          if (!pathResult.match) {
            return jsonResponse(404, { ok: false, error: "Not found" });
          }

          // Extract channel/account from path: {prefix}/{channel}/{account?}
          const channel = pathResult.segments[0] ?? undefined;
          const account = pathResult.segments[1] ?? undefined;

          // Extract peer from header
          const peer = request.headers.get("X-Webhook-Peer") ?? "webhook";

          // Read and parse JSON body with streaming size enforcement
          const bodyResult = await parseJsonBody(request, maxBodyBytes);
          if (!bodyResult.ok) {
            return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.message });
          }
          const rawBody = bodyResult.raw;
          const payload = bodyResult.parsed;

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

          try {
            dispatcher(session, frame);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResponse(500, { ok: false, error: `Dispatch failed: ${message}`, frameId });
          }

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
