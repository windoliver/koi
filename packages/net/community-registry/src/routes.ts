/**
 * REST route handlers for the community registry.
 *
 * Each handler receives the parsed URL, request, and config, and returns a
 * Response. The router in handler.ts dispatches to these functions based on
 * method + path pattern.
 */

import type { BrickArtifact, BrickKind, BrickSearchQuery } from "@koi/core";
import { evaluateSecurityGate } from "./security-gate.js";
import type { BatchCheckRequest, CommunityRegistryConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

const VALID_BRICK_KINDS: ReadonlySet<string> = new Set([
  "tool",
  "skill",
  "agent",
  "middleware",
  "channel",
  "composite",
]);

function isValidBrickKind(value: string): value is BrickKind {
  return VALID_BRICK_KINDS.has(value);
}

/** Sentinel path segment meaning "no namespace". */
const NO_NAMESPACE_SENTINEL = "_";

// ---------------------------------------------------------------------------
// GET /v1/health
// ---------------------------------------------------------------------------

export function handleHealth(): Response {
  return jsonResponse({ status: "ok" });
}

// ---------------------------------------------------------------------------
// GET /v1/bricks — search
// ---------------------------------------------------------------------------

export async function handleSearch(url: URL, config: CommunityRegistryConfig): Promise<Response> {
  const kindParam = url.searchParams.get("kind");
  const text = url.searchParams.get("text") ?? undefined;
  const tagsParam = url.searchParams.get("tags");
  const namespace = url.searchParams.get("namespace") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor") ?? undefined;

  if (kindParam !== null && !isValidBrickKind(kindParam)) {
    return errorResponse(`Invalid brick kind: ${kindParam}`, 400);
  }

  const query: BrickSearchQuery = {
    ...(kindParam !== null && isValidBrickKind(kindParam) ? { kind: kindParam } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(tagsParam !== null ? { tags: tagsParam.split(",").map((t) => t.trim()) } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };

  const page = await config.registry.search(query);
  return jsonResponse(page);
}

// ---------------------------------------------------------------------------
// GET /v1/bricks/:namespace/:name — get by namespace + name
// ---------------------------------------------------------------------------

export async function handleGetByName(
  rawNamespace: string,
  name: string,
  url: URL,
  config: CommunityRegistryConfig,
): Promise<Response> {
  const kindParam = url.searchParams.get("kind");

  if (kindParam !== null && !isValidBrickKind(kindParam)) {
    return errorResponse(`Invalid brick kind: ${kindParam}`, 400);
  }

  // "_" is the sentinel for "no namespace"
  const namespace =
    rawNamespace === NO_NAMESPACE_SENTINEL ? undefined : decodeURIComponent(rawNamespace);

  const kind: BrickKind = kindParam !== null && isValidBrickKind(kindParam) ? kindParam : "tool";
  const result = await config.registry.get(kind, name, namespace);

  if (!result.ok) {
    return errorResponse(result.error.message, 404);
  }

  return jsonResponse(result.value);
}

// ---------------------------------------------------------------------------
// GET /v1/bricks/hash/:contentHash — get by content hash
// ---------------------------------------------------------------------------

export async function handleGetByHash(
  contentHash: string,
  config: CommunityRegistryConfig,
): Promise<Response> {
  const page = await config.registry.search({});
  const match = page.items.find(
    (brick) => brick.id === contentHash || brick.provenance.contentHash === contentHash,
  );

  if (match === undefined) {
    return errorResponse(`Brick with hash ${contentHash} not found`, 404);
  }

  return jsonResponse(match);
}

// ---------------------------------------------------------------------------
// POST /v1/bricks — publish
// ---------------------------------------------------------------------------

export async function handlePublish(
  req: Request,
  config: CommunityRegistryConfig,
): Promise<Response> {
  // 1. Check auth
  const authHeader = req.headers.get("authorization");
  if (authHeader === null || !authHeader.startsWith("Bearer ")) {
    return errorResponse("Missing or invalid Authorization header", 401);
  }

  const token = authHeader.slice("Bearer ".length);
  if (config.authTokens === undefined || !config.authTokens.has(token)) {
    return errorResponse("Invalid auth token", 403);
  }

  // 2. Parse body
  let brick: BrickArtifact;
  try {
    brick = (await req.json()) as BrickArtifact;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Invalid JSON";
    return errorResponse(`Bad request body: ${message}`, 400);
  }

  // 3. Mandatory validation: provenance must be present
  if (brick.provenance === undefined) {
    return errorResponse("Brick is missing provenance metadata", 400);
  }

  // 4. Mandatory validation: content hash must match ID
  if (config.verifyIntegrity !== undefined) {
    const integrityResult = config.verifyIntegrity(brick);
    if (!integrityResult.ok) {
      return jsonResponse(
        {
          error: `Content integrity check failed: ${integrityResult.kind}`,
          integrityKind: integrityResult.kind,
        },
        422,
      );
    }
  }

  // 5. Mandatory validation: attestation signature (when verifier provided)
  if (config.verifyAttestation !== undefined && brick.provenance.attestation !== undefined) {
    const attestationValid = await config.verifyAttestation(brick);
    if (!attestationValid) {
      return errorResponse("Attestation signature verification failed", 422);
    }
  }

  // 6. Security gate (skill-scanner integration + NL injection scan)
  const decision = await evaluateSecurityGate(config.securityGate, brick);
  if (decision.verdict === "blocked") {
    return jsonResponse(
      {
        error: "Security gate blocked publication",
        score: decision.result.score,
        findings: decision.result.findings ?? [],
      },
      403,
    );
  }

  // 7. Register
  const result = await config.registry.register(brick);
  if (!result.ok) {
    return errorResponse(result.error.message, 500);
  }

  // 8. Return PublishResult matching the client contract
  const ns = brick.namespace !== undefined ? `${brick.namespace}/` : "";
  return jsonResponse(
    {
      id: brick.id,
      kind: brick.kind,
      name: brick.name,
      url: `/v1/bricks/${ns.length > 0 ? encodeURIComponent(brick.namespace ?? "") : "_"}/${encodeURIComponent(brick.name)}`,
      publishedAt: new Date().toISOString(),
      ...(decision.verdict === "warning" ? { warnings: decision.result.findings ?? [] } : {}),
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// POST /v1/batch-check — check hash availability
// ---------------------------------------------------------------------------

export async function handleBatchCheck(
  req: Request,
  config: CommunityRegistryConfig,
): Promise<Response> {
  let body: BatchCheckRequest;
  try {
    body = (await req.json()) as BatchCheckRequest;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Invalid JSON";
    return errorResponse(`Bad request body: ${message}`, 400);
  }

  if (!Array.isArray(body.hashes)) {
    return errorResponse("Missing 'hashes' array in request body", 400);
  }

  // Search once and build a hash set for O(1) lookups
  const page = await config.registry.search({});
  const knownHashes = new Set<string>();
  for (const brick of page.items) {
    knownHashes.add(brick.id);
    knownHashes.add(brick.provenance.contentHash);
  }

  // Return { existing, missing } matching client BatchCheckResult type
  const existing: string[] = [];
  const missing: string[] = [];
  for (const hash of body.hashes) {
    if (knownHashes.has(hash)) {
      existing.push(hash);
    } else {
      missing.push(hash);
    }
  }

  return jsonResponse({ existing, missing });
}
