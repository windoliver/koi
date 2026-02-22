/**
 * HTTP health check server for deployed Koi agents.
 *
 * Provides:
 * - GET /health       → 200 "ok" (liveness, instant)
 * - GET /health/ready → 200 "ready" or 503 "not ready" (readiness check)
 *
 * All responses include `Connection: close` to minimize memory usage.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthServerConfig {
  readonly port: number;
  readonly onReady?: (() => boolean | Promise<boolean>) | undefined;
}

export interface HealthServer {
  readonly start: () => Promise<{ readonly url: string; readonly port: number }>;
  readonly stop: () => void;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function healthResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain",
      Connection: "close",
      "Cache-Control": "no-store",
    },
  });
}

// ---------------------------------------------------------------------------
// Request handler (exported for unit testing)
// ---------------------------------------------------------------------------

export function createHealthHandler(
  onReady?: (() => boolean | Promise<boolean>) | undefined,
): (req: Request) => Response | Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return healthResponse(200, "ok");
    }

    if (url.pathname === "/health/ready") {
      if (onReady === undefined) {
        return healthResponse(200, "ready");
      }
      const ready = await onReady();
      return ready ? healthResponse(200, "ready") : healthResponse(503, "not ready");
    }

    return healthResponse(404, "not found");
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHealthServer(config: HealthServerConfig): HealthServer {
  let server: ReturnType<typeof Bun.serve> | undefined;

  return {
    async start(): Promise<{ readonly url: string; readonly port: number }> {
      const handler = createHealthHandler(config.onReady);

      server = Bun.serve({
        port: config.port,
        fetch: handler,
      });

      const port = server.port ?? config.port;

      return {
        url: server.url.toString(),
        port,
      };
    },

    stop() {
      if (server !== undefined) {
        server.stop(true);
        server = undefined;
      }
    },
  };
}
