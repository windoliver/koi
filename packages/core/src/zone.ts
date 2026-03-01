/**
 * Zone types — multi-zone agent coordination (L0 contract).
 *
 * Defines ZoneId branded type, ZoneDescriptor, ZoneEvent discriminated union,
 * and the ZoneRegistry interface for zone lifecycle management.
 *
 * Exception: zoneId() branded type constructor is permitted in L0 as a
 * zero-logic identity cast for type safety.
 */

// ---------------------------------------------------------------------------
// Branded type
// ---------------------------------------------------------------------------

declare const __zoneBrand: unique symbol;

/** Branded string type for zone identifiers. */
export type ZoneId = string & { readonly [__zoneBrand]: "ZoneId" };

/** Create a branded ZoneId from a plain string. */
export function zoneId(id: string): ZoneId {
  return id as ZoneId;
}

// ---------------------------------------------------------------------------
// Zone status
// ---------------------------------------------------------------------------

/** Zone lifecycle states. */
export type ZoneStatus = "active" | "draining" | "offline";

// ---------------------------------------------------------------------------
// Zone descriptor
// ---------------------------------------------------------------------------

/** A registered zone's identity and metadata. */
export interface ZoneDescriptor {
  readonly zoneId: ZoneId;
  readonly displayName: string;
  readonly status: ZoneStatus;
  /** Arbitrary metadata (labels, region, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Unix timestamp ms when the zone was registered. */
  readonly registeredAt: number;
}

// ---------------------------------------------------------------------------
// Zone events (discriminated union)
// ---------------------------------------------------------------------------

/** Events emitted by the ZoneRegistry on zone state changes. */
export type ZoneEvent =
  | { readonly kind: "zone_registered"; readonly descriptor: ZoneDescriptor }
  | { readonly kind: "zone_deregistered"; readonly zoneId: ZoneId }
  | { readonly kind: "zone_updated"; readonly descriptor: ZoneDescriptor }
  | {
      readonly kind: "zone_status_changed";
      readonly zoneId: ZoneId;
      readonly from: ZoneStatus;
      readonly to: ZoneStatus;
    };

// ---------------------------------------------------------------------------
// Zone filter
// ---------------------------------------------------------------------------

/** Filter criteria for listing registered zones. */
export interface ZoneFilter {
  readonly status?: ZoneStatus | undefined;
  readonly zoneId?: ZoneId | undefined;
}

// ---------------------------------------------------------------------------
// Zone registry (L0 contract)
// ---------------------------------------------------------------------------

/**
 * Pluggable zone lifecycle registry. Manages zone registration, lookup,
 * listing, and change notification.
 *
 * All methods return `T | Promise<T>` — in-memory implementations are sync,
 * network-backed implementations (e.g., Nexus) are async.
 */
export interface ZoneRegistry extends AsyncDisposable {
  /** Register a new zone. Returns the stored descriptor. */
  readonly register: (descriptor: ZoneDescriptor) => ZoneDescriptor | Promise<ZoneDescriptor>;

  /** Remove a zone from the registry. Returns true if found. */
  readonly deregister: (zoneId: ZoneId) => boolean | Promise<boolean>;

  /** Look up a zone by ID. Returns undefined if not found. */
  readonly lookup: (
    zoneId: ZoneId,
  ) => ZoneDescriptor | undefined | Promise<ZoneDescriptor | undefined>;

  /** List zones matching an optional filter. */
  readonly list: (
    filter?: ZoneFilter,
  ) => readonly ZoneDescriptor[] | Promise<readonly ZoneDescriptor[]>;

  /** Subscribe to zone change events. Returns unsubscribe function. */
  readonly watch: (listener: (event: ZoneEvent) => void) => () => void;
}
