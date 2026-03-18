/**
 * Community registry HTTP handler — simple URL-pattern router.
 *
 * Returns `null` for unmatched routes so the handler can be composed with
 * other handlers in a larger server.
 */

import {
  handleBatchCheck,
  handleGetByHash,
  handleGetByName,
  handleHealth,
  handlePublish,
  handleSearch,
} from "./routes.js";
import type { CommunityRegistryConfig } from "./types.js";

export interface CommunityRegistryHandler {
  readonly handler: (req: Request) => Promise<Response | null>;
  readonly dispose: () => void;
}

/**
 * Create a community registry HTTP handler.
 *
 * The returned `handler` function processes requests under `/v1/` and returns
 * `null` for any route it does not recognise.
 */
export function createCommunityRegistryHandler(
  config: CommunityRegistryConfig,
): CommunityRegistryHandler {
  let disposed = false;

  async function handler(req: Request): Promise<Response | null> {
    if (disposed) {
      return new Response("Service unavailable", { status: 503 });
    }

    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const path = url.pathname;

    // -----------------------------------------------------------------------
    // GET /v1/health
    // -----------------------------------------------------------------------
    if (method === "GET" && path === "/v1/health") {
      return handleHealth();
    }

    // -----------------------------------------------------------------------
    // POST /v1/batch-check
    // -----------------------------------------------------------------------
    if (method === "POST" && path === "/v1/batch-check") {
      return handleBatchCheck(req, config);
    }

    // -----------------------------------------------------------------------
    // POST /v1/bricks — publish
    // -----------------------------------------------------------------------
    if (method === "POST" && path === "/v1/bricks") {
      return handlePublish(req, config);
    }

    // -----------------------------------------------------------------------
    // GET /v1/bricks/hash/:contentHash
    // -----------------------------------------------------------------------
    const hashMatch = path.match(/^\/v1\/bricks\/hash\/([^/]+)$/);
    if (method === "GET" && hashMatch !== null) {
      const contentHash = hashMatch[1];
      if (contentHash === undefined) {
        return null;
      }
      return handleGetByHash(contentHash, config);
    }

    // -----------------------------------------------------------------------
    // GET /v1/bricks/:namespace/:name
    // -----------------------------------------------------------------------
    const nameMatch = path.match(/^\/v1\/bricks\/([^/]+)\/([^/]+)$/);
    if (method === "GET" && nameMatch !== null) {
      const namespace = nameMatch[1];
      const name = nameMatch[2];
      if (namespace === undefined || name === undefined) {
        return null;
      }
      return handleGetByName(namespace, name, url, config);
    }

    // -----------------------------------------------------------------------
    // GET /v1/bricks — search
    // -----------------------------------------------------------------------
    if (method === "GET" && path === "/v1/bricks") {
      return handleSearch(url, config);
    }

    // Unmatched route
    return null;
  }

  function dispose(): void {
    disposed = true;
  }

  return { handler, dispose };
}
