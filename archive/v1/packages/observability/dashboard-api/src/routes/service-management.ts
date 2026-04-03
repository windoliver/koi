/**
 * Service management route handlers — shutdown, status, demo, deploy.
 *
 * Each handler follows the thin-adapter pattern: validate -> delegate -> respond.
 */

import type { DemoPackSummary, DetailedStatusResponse } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { errorResponse, jsonResponse } from "../router.js";

/** Callbacks for service management operations — injected by the host. */
export interface ServiceManagementCallbacks {
  readonly shutdown: () => Promise<void>;
  readonly detailedStatus: () => Promise<DetailedStatusResponse>;
  readonly demoInit: (packId: string) => Promise<void>;
  readonly demoReset: (packId: string) => Promise<void>;
  readonly demoPacks: () => Promise<readonly DemoPackSummary[]>;
  readonly deploy: () => Promise<void>;
  readonly undeploy: () => Promise<void>;
}

/** Validate that X-Confirm: true header is present. */
function requireConfirmHeader(req: Request): Response | null {
  if (req.headers.get("X-Confirm") !== "true") {
    return errorResponse(
      "VALIDATION",
      "Missing required X-Confirm: true header — this is a destructive operation",
      400,
    );
  }
  return null;
}

/** POST /cmd/shutdown — graceful shutdown. */
export async function handleShutdown(
  req: Request,
  _params: RouteParams,
  callbacks: ServiceManagementCallbacks,
): Promise<Response> {
  const rejected = requireConfirmHeader(req);
  if (rejected !== null) return rejected;

  // Fire-and-forget — respond 202 immediately
  callbacks.shutdown().catch(() => {});
  return new Response(JSON.stringify({ ok: true, data: null }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
}

/** GET /status/detailed — subsystem health status. */
export async function handleDetailedStatus(
  _req: Request,
  _params: RouteParams,
  callbacks: ServiceManagementCallbacks,
): Promise<Response> {
  const status = await callbacks.detailedStatus();
  return jsonResponse(status);
}

/** POST /cmd/demo/init — initialize a demo pack. */
export async function handleDemoInit(
  req: Request,
  _params: RouteParams,
  callbacks: ServiceManagementCallbacks,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null || !("packId" in body)) {
    return errorResponse("VALIDATION", "Missing required field: packId", 400);
  }

  const { packId } = body as { readonly packId: string };
  if (typeof packId !== "string" || packId.length === 0) {
    return errorResponse("VALIDATION", "packId must be a non-empty string", 400);
  }

  await callbacks.demoInit(packId);
  return jsonResponse(null);
}

/** POST /cmd/demo/reset — reset a demo pack. */
export async function handleDemoReset(
  req: Request,
  _params: RouteParams,
  callbacks: ServiceManagementCallbacks,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null || !("packId" in body)) {
    return errorResponse("VALIDATION", "Missing required field: packId", 400);
  }

  const { packId } = body as { readonly packId: string };
  if (typeof packId !== "string" || packId.length === 0) {
    return errorResponse("VALIDATION", "packId must be a non-empty string", 400);
  }

  await callbacks.demoReset(packId);
  return jsonResponse(null);
}

/** GET /demo/packs — list available demo packs. */
export async function handleDemoPacks(
  _req: Request,
  _params: RouteParams,
  callbacks: ServiceManagementCallbacks,
): Promise<Response> {
  const packs = await callbacks.demoPacks();
  return jsonResponse(packs);
}

/** POST /cmd/deploy — trigger deployment. */
export async function handleDeploy(
  req: Request,
  _params: RouteParams,
  callbacks: ServiceManagementCallbacks,
): Promise<Response> {
  const rejected = requireConfirmHeader(req);
  if (rejected !== null) return rejected;

  await callbacks.deploy();
  return jsonResponse(null);
}

/** DELETE /cmd/deploy — undo deployment. */
export async function handleUndeploy(
  req: Request,
  _params: RouteParams,
  callbacks: ServiceManagementCallbacks,
): Promise<Response> {
  const rejected = requireConfirmHeader(req);
  if (rejected !== null) return rejected;

  await callbacks.undeploy();
  return jsonResponse(null);
}
