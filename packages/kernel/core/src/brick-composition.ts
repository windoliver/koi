/**
 * Brick composition algebra — pipeline composition types.
 *
 * Defines typed ports, wiring, and composition metadata for composed bricks.
 * v1: pipeline only (`A >>> B >>> C`). Future operators (parallel, conditional)
 * extend the `BrickComposition` discriminated union.
 */

import type { BrickId } from "./brick-snapshot.js";

// ---------------------------------------------------------------------------
// Composition operator — discriminant for BrickComposition union
// ---------------------------------------------------------------------------

export type CompositionOperator = "pipeline";

// ---------------------------------------------------------------------------
// Ports — typed I/O endpoints on a brick
// ---------------------------------------------------------------------------

export interface CompositionPort {
  readonly name: string;
  readonly direction: "in" | "out";
  /** JSON Schema describing the port's data shape. */
  readonly schema: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Wiring — connections between brick ports
// ---------------------------------------------------------------------------

export interface CompositionWireEndpoint {
  readonly brickId: BrickId;
  readonly port: string;
}

export interface CompositionWire {
  readonly from: CompositionWireEndpoint;
  readonly to: CompositionWireEndpoint;
}

// ---------------------------------------------------------------------------
// Pipeline composition — sequential brick execution
// ---------------------------------------------------------------------------

export interface PipelineComposition {
  readonly operator: "pipeline";
  /** Ordered list of source brick IDs in pipeline order. */
  readonly sourceBricks: readonly BrickId[];
  /** Wires connecting consecutive brick ports. */
  readonly wires: readonly CompositionWire[];
  /** Ports exposed by the composed brick (first in + last out). */
  readonly exposedPorts: readonly CompositionPort[];
}

// ---------------------------------------------------------------------------
// BrickComposition — discriminated union on `operator`
// ---------------------------------------------------------------------------

/**
 * Composition metadata — how a brick was assembled from other bricks.
 * Discriminated on `operator` for exhaustive pattern matching.
 */
export type BrickComposition = PipelineComposition;

// ---------------------------------------------------------------------------
// Composition validation types
// ---------------------------------------------------------------------------

export type CompositionErrorKind =
  | "type_mismatch"
  | "missing_port"
  | "disconnected"
  | "too_many_bricks"
  | "duplicate_brick"
  | "schema_conflict";

export interface CompositionError {
  readonly kind: CompositionErrorKind;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export type CompositionCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly errors: readonly CompositionError[] };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of bricks in a single pipeline composition. */
export const MAX_PIPELINE_LENGTH = 10;
