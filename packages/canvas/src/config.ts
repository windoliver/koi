/**
 * Canvas configuration with sensible defaults.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config type
// ---------------------------------------------------------------------------

export interface CanvasConfig {
  /** Maximum number of components per surface. */
  readonly maxComponents: number;
  /** Maximum component tree depth (DFS cycle detection limit). */
  readonly maxTreeDepth: number;
  /** Maximum number of surfaces per session. */
  readonly maxSurfaces: number;
  /** Maximum serialized surface size in bytes. */
  readonly maxSerializedBytes: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CANVAS_CONFIG: CanvasConfig = Object.freeze({
  maxComponents: 1_000,
  maxTreeDepth: 50,
  maxSurfaces: 100,
  maxSerializedBytes: 1_048_576, // 1 MiB
});

// ---------------------------------------------------------------------------
// Schema (module-private)
// ---------------------------------------------------------------------------

const canvasConfigSchema = z.object({
  maxComponents: z.number().int().positive(),
  maxTreeDepth: z.number().int().positive(),
  maxSurfaces: z.number().int().positive(),
  maxSerializedBytes: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates raw input against the CanvasConfig schema. */
export function validateCanvasConfig(raw: unknown): Result<CanvasConfig, KoiError> {
  return validateWith(canvasConfigSchema, raw, "CanvasConfig validation failed");
}
