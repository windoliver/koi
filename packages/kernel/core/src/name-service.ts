/**
 * Agent Name Service (ANS) — DNS-like name resolution for agents and bricks.
 *
 * Maps human-readable names to AgentId (running agents) and BrickId (forged
 * bricks), with scoped visibility, aliases, TTL-based expiry, and fuzzy
 * suggestions.
 *
 * Informed by the IETF ANS draft (TTL defaults, resolution algorithm) and
 * Microsoft Multi-Agent Reference Architecture (registry patterns).
 */

import type { BrickId } from "./brick-snapshot.js";
import type { AgentId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import type { BrickKind, ForgeScope } from "./forge-types.js";

// ---------------------------------------------------------------------------
// Binding — what a resolved name points to
// ---------------------------------------------------------------------------

/** Discriminated union: a name resolves to either a running agent or a forged brick. */
export type NameBinding =
  | { readonly kind: "agent"; readonly agentId: AgentId }
  | { readonly kind: "brick"; readonly brickId: BrickId; readonly brickKind: BrickKind };

// ---------------------------------------------------------------------------
// Record — a registered name entry
// ---------------------------------------------------------------------------

/** A registered name record with scope, aliases, and TTL metadata. */
export interface NameRecord {
  readonly name: string;
  readonly binding: NameBinding;
  readonly scope: ForgeScope;
  readonly aliases: readonly string[];
  readonly registeredAt: number;
  /** Epoch ms when this record expires. 0 = no expiry. */
  readonly expiresAt: number;
  readonly registeredBy: string;
}

// ---------------------------------------------------------------------------
// Resolution — result of a successful name lookup
// ---------------------------------------------------------------------------

/** Resolution result with match metadata. */
export interface NameResolution {
  readonly record: NameRecord;
  /** Whether the name was matched via an alias rather than the canonical name. */
  readonly matchedAlias: boolean;
  /** The actual string that matched (canonical name or alias). */
  readonly matchedName: string;
}

// ---------------------------------------------------------------------------
// Suggestion — fuzzy match for typos / "did you mean?"
// ---------------------------------------------------------------------------

/** A fuzzy match suggestion with Levenshtein distance. */
export interface NameSuggestion {
  readonly name: string;
  readonly distance: number;
  readonly scope: ForgeScope;
  readonly binding: NameBinding;
}

// ---------------------------------------------------------------------------
// Query — search filter
// ---------------------------------------------------------------------------

/** Filter criteria for searching registered names. */
export interface NameQuery {
  readonly scope?: ForgeScope;
  readonly bindingKind?: "agent" | "brick";
  readonly text?: string;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

/** The kind of change that occurred in the name service. */
export type NameChangeKind = "registered" | "unregistered" | "expired" | "renewed";

/** Emitted when a name record changes. */
export interface NameChangeEvent {
  readonly kind: NameChangeKind;
  readonly name: string;
  readonly scope: ForgeScope;
  readonly binding?: NameBinding;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** ANS configuration with sensible defaults per IETF ANS draft. */
export interface AnsConfig {
  /** Default TTL in milliseconds. 0 = no expiry. Default: 300_000 (5 min). */
  readonly defaultTtlMs: number;
  /** Maximum number of aliases per name. Default: 10. */
  readonly maxAliasesPerName: number;
  /** Maximum Levenshtein distance for suggestions. Default: 3. */
  readonly maxSuggestionDistance: number;
  /** Maximum number of suggestions returned. Default: 5. */
  readonly maxSuggestions: number;
  /** Safety valve: maximum total records. Default: 10_000. */
  readonly maxRecords: number;
}

/** Default ANS configuration per IETF ANS draft. */
export const DEFAULT_ANS_CONFIG: Readonly<AnsConfig> = Object.freeze({
  defaultTtlMs: 300_000,
  maxAliasesPerName: 10,
  maxSuggestionDistance: 3,
  maxSuggestions: 5,
  maxRecords: 10_000,
} as const satisfies AnsConfig);

// ---------------------------------------------------------------------------
// Registration input
// ---------------------------------------------------------------------------

/** Input for registering a new name binding. */
export interface NameRegistration {
  readonly name: string;
  readonly binding: NameBinding;
  readonly scope: ForgeScope;
  readonly aliases?: readonly string[];
  /** TTL in milliseconds. Uses config default when omitted. */
  readonly ttlMs?: number;
  readonly registeredBy: string;
}

// ---------------------------------------------------------------------------
// Scope resolution priority
// ---------------------------------------------------------------------------

/**
 * Resolution priority by scope — lower number = checked first.
 * Agent-scoped names shadow zone-scoped, which shadow global.
 */
export const ANS_SCOPE_PRIORITY: Readonly<Record<ForgeScope, number>> = Object.freeze({
  agent: 0,
  zone: 1,
  global: 2,
} as const satisfies Record<ForgeScope, number>);

// ---------------------------------------------------------------------------
// Reader interface — exposed as agent component
// ---------------------------------------------------------------------------

/** Read-only name resolution interface exposed to agents via ECS. */
export interface NameServiceReader {
  /** Resolve a name to a binding, optionally within a specific scope. */
  readonly resolve: (
    name: string,
    scope?: ForgeScope,
  ) => Result<NameResolution, KoiError> | Promise<Result<NameResolution, KoiError>>;

  /** Search registered names by query criteria. */
  readonly search: (query: NameQuery) => readonly NameRecord[] | Promise<readonly NameRecord[]>;

  /** Get fuzzy suggestions for a name that didn't resolve. */
  readonly suggest: (
    name: string,
    scope?: ForgeScope,
  ) => readonly NameSuggestion[] | Promise<readonly NameSuggestion[]>;

  /** Subscribe to name change events. Returns an unsubscribe function. */
  readonly onChange?: (listener: (event: NameChangeEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Writer interface — used by system code, not exposed to agents
// ---------------------------------------------------------------------------

/** Write interface for name registration, used by system code only. */
export interface NameServiceWriter {
  /** Register a name binding. Idempotent for same binding. */
  readonly register: (
    registration: NameRegistration,
  ) => Result<NameRecord, KoiError> | Promise<Result<NameRecord, KoiError>>;

  /** Unregister a name in a specific scope. Returns true if found. */
  readonly unregister: (name: string, scope: ForgeScope) => boolean | Promise<boolean>;

  /** Renew a name's TTL. Returns updated record or NOT_FOUND. */
  readonly renew: (
    name: string,
    scope: ForgeScope,
    ttlMs?: number,
  ) => Result<NameRecord, KoiError> | Promise<Result<NameRecord, KoiError>>;
}

// ---------------------------------------------------------------------------
// Combined backend
// ---------------------------------------------------------------------------

/** Combined read/write name service backend with optional cleanup. */
export interface NameServiceBackend extends NameServiceReader, NameServiceWriter {
  /** Release all resources (timers, listeners, etc.). */
  readonly dispose?: () => void | Promise<void>;
}
