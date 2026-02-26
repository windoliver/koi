/**
 * Catch-all error handler — wraps route handlers to ensure
 * errors never leak stack traces to the client.
 */

import { errorResponse } from "../router.js";

/** Wrap a handler to catch unexpected errors and return a JSON error envelope. */
export function withErrorHandler(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req);
    } catch (e: unknown) {
      // Log full error server-side for debugging — never expose to client
      console.error("[dashboard-api] Unhandled error:", e);
      return errorResponse("INTERNAL", "Internal server error", 500);
    }
  };
}
