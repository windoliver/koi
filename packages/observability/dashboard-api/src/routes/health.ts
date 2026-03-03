/**
 * Health check endpoint — GET /dashboard/api/health
 */

import { jsonResponse } from "../router.js";

const startedAt = Date.now();

export function handleHealth(): Response {
  return jsonResponse({
    status: "ok",
    uptimeMs: Date.now() - startedAt,
  });
}
