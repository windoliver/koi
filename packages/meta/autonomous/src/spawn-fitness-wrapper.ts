/**
 * Spawn fitness wrapper — records spawn outcomes to a health tracker.
 *
 * Wraps a spawn function to track success/failure metrics per agent brick,
 * enabling fitness-based variant selection to evolve over time.
 */

import type { AgentManifest } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Minimal health recording interface (subset of ToolHealthTracker). */
export interface SpawnHealthRecorder {
  readonly recordSuccess: (id: string, latencyMs: number) => void;
  readonly recordFailure: (id: string, latencyMs: number, error: string) => void;
}

export interface SpawnFitnessWrapperConfig {
  readonly healthRecorder: SpawnHealthRecorder;
  /** Injectable clock for testing. Default: Date.now. */
  readonly clock?: (() => number) | undefined;
}

/** Generic spawn request — must have at least a manifest. */
interface SpawnRequestLike {
  readonly manifest: AgentManifest;
  readonly [key: string]: unknown;
}

/** Generic spawn result — discriminated ok/error union. */
type SpawnResultLike =
  | { readonly ok: true; readonly [key: string]: unknown }
  | { readonly ok: false; readonly error: string; readonly [key: string]: unknown };

// ---------------------------------------------------------------------------
// Metadata key for brickId threading
// ---------------------------------------------------------------------------

/** Key used to thread brickId through manifest metadata. */
const BRICK_ID_METADATA_KEY = "__brickId";

/** Extracts brickId from manifest metadata, if present. */
function extractBrickId(manifest: AgentManifest): string | undefined {
  const metadata = manifest.metadata as Readonly<Record<string, unknown>> | undefined;
  if (metadata === undefined) return undefined;
  const brickId = metadata[BRICK_ID_METADATA_KEY];
  return typeof brickId === "string" ? brickId : undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Wraps a spawn function to record outcomes to a health tracker. */
export function createSpawnFitnessWrapper<
  TReq extends SpawnRequestLike,
  TRes extends SpawnResultLike,
>(
  spawn: (request: TReq) => Promise<TRes>,
  config: SpawnFitnessWrapperConfig,
): (request: TReq) => Promise<TRes> {
  const { healthRecorder, clock = Date.now } = config;

  return async (request: TReq): Promise<TRes> => {
    const brickId = extractBrickId(request.manifest);
    const start = clock();

    // eslint-disable-next-line no-restricted-syntax -- justified: let for try/catch result capture
    let result: TRes;
    try {
      result = await spawn(request);
    } catch (e: unknown) {
      const latencyMs = clock() - start;
      if (brickId !== undefined) {
        const message = e instanceof Error ? e.message : String(e);
        healthRecorder.recordFailure(brickId, latencyMs, message);
      }
      throw e;
    }

    const latencyMs = clock() - start;
    if (brickId !== undefined) {
      if (result.ok) {
        healthRecorder.recordSuccess(brickId, latencyMs);
      } else {
        healthRecorder.recordFailure(brickId, latencyMs, result.error);
      }
    }

    return result;
  };
}

/** Embeds a brickId into a manifest's metadata for downstream tracking. */
export function embedBrickId(manifest: AgentManifest, brickId: string): AgentManifest {
  const existingMetadata = (manifest.metadata ?? {}) as Readonly<Record<string, unknown>>;
  return {
    ...manifest,
    metadata: { ...existingMetadata, [BRICK_ID_METADATA_KEY]: brickId },
  };
}
