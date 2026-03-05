/**
 * User model types — unified preference learning + sensor enrichment.
 *
 * L0 types only — no function bodies, no runtime code.
 */

import type { MemoryResult } from "./ecs.js";

// ---------------------------------------------------------------------------
// Signal types
// ---------------------------------------------------------------------------

/** A signal ingested by the user model from any channel. */
export type UserSignal =
  | {
      readonly kind: "pre_action";
      readonly question: string;
      readonly answer: string;
    }
  | {
      readonly kind: "post_action";
      readonly correction: string;
      readonly source: "explicit" | "drift";
      readonly supersedes?: readonly string[] | undefined;
    }
  | {
      readonly kind: "sensor";
      readonly source: string;
      readonly values: Readonly<Record<string, unknown>>;
    };

// ---------------------------------------------------------------------------
// Signal sink + source
// ---------------------------------------------------------------------------

/** Write-side interface for ingesting user signals. */
export interface SignalSink {
  readonly ingest: (signal: UserSignal) => void | Promise<void>;
}

/** Read-side interface for external signal sources (sensors, IDE, etc.). */
export interface SignalSource {
  readonly name: string;
  readonly read: () => UserSignal | Promise<UserSignal>;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Point-in-time read-only view of the user model state. */
export interface UserSnapshot {
  readonly preferences: readonly MemoryResult[];
  readonly state: Readonly<Record<string, unknown>>;
  readonly ambiguityDetected: boolean;
  readonly suggestedQuestion?: string | undefined;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** ECS component combining read (snapshot) + write (sink) for user modeling. */
export interface UserModelComponent {
  readonly snapshot: () => UserSnapshot | Promise<UserSnapshot>;
  readonly sink: SignalSink;
}
