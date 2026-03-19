/**
 * Publish a brick artifact to the community registry.
 *
 * Validates that the brick has provenance before publishing.
 * Uses integrity verification to ensure content has not been tampered with.
 */

import type { BrickArtifact, KoiError, Result } from "@koi/core";
import { toKoiError } from "@koi/errors";
import type { IntegrityVerifier, PublishOptions, PublishResult } from "./types.js";
import { DEFAULT_PUBLISH_TIMEOUT_MS } from "./types.js";

/** Passthrough verifier — always succeeds. Callers should provide a real verifier. */
const passthroughVerifier: IntegrityVerifier = () => ({ ok: true, kind: "ok" });

// ---------------------------------------------------------------------------
// Publish function
// ---------------------------------------------------------------------------

/**
 * Publish a brick artifact to the community registry.
 *
 * Validates:
 * 1. The brick has provenance metadata
 * 2. The brick's content integrity is valid (content hash matches ID)
 *
 * Returns the published URL on success or a KoiError on failure.
 */
export async function publishBrick(
  brick: BrickArtifact,
  options: PublishOptions,
): Promise<Result<PublishResult, KoiError>> {
  // Validate provenance exists
  if (brick.provenance === undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Cannot publish brick without provenance metadata",
        retryable: false,
        context: { brickId: brick.id, brickName: brick.name },
      },
    };
  }

  // Verify content integrity before publishing
  const verify = options.verifyIntegrity ?? passthroughVerifier;
  const integrity = verify(brick);
  if (!integrity.ok) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Brick content integrity check failed: ${integrity.kind}`,
        retryable: false,
        context: { brickId: brick.id, integrityKind: integrity.kind },
      },
    };
  }

  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const registryUrl = options.registryUrl.replace(/\/+$/, "");
  const url = `${registryUrl}/v1/bricks`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.authToken}`,
      },
      body: JSON.stringify(brick),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        error: mapPublishError(response.status, text, url),
      };
    }

    const data = (await response.json()) as PublishResult;
    return { ok: true, value: data };
  } catch (e: unknown) {
    clearTimeout(timer);

    if (e instanceof DOMException && e.name === "AbortError") {
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: `Publish request to ${url} timed out after ${timeoutMs}ms`,
          retryable: true,
          context: { url, timeoutMs },
        },
      };
    }

    return { ok: false, error: toKoiError(e) };
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapPublishError(status: number, body: string, url: string): KoiError {
  if (status === 401) {
    return {
      code: "PERMISSION",
      message: "Authentication required to publish bricks. Provide a valid auth token.",
      retryable: false,
      context: { url, status },
    };
  }
  if (status === 403) {
    return {
      code: "PERMISSION",
      message: "Insufficient permissions to publish to this registry",
      retryable: false,
      context: { url, status },
    };
  }
  if (status === 409) {
    return {
      code: "CONFLICT",
      message: `Brick already exists in the registry: ${body || "conflict"}`,
      retryable: false,
      context: { url, status },
    };
  }
  if (status === 413) {
    return {
      code: "VALIDATION",
      message: "Brick payload too large for the registry",
      retryable: false,
      context: { url, status },
    };
  }
  if (status >= 500) {
    return {
      code: "EXTERNAL",
      message: `Registry server error (${status}): ${body || url}`,
      retryable: true,
      context: { url, status },
    };
  }
  return {
    code: "EXTERNAL",
    message: `Publish failed with HTTP ${status}: ${body || url}`,
    retryable: false,
    context: { url, status },
  };
}
