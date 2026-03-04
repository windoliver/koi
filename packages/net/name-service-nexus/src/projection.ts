/**
 * Local projection cache for Nexus ANS records.
 *
 * Maintains an in-memory mirror of Nexus name records with diff detection
 * for poll-based synchronization. All mutation functions return change events
 * for downstream notification.
 */

import type { ForgeScope, NameChangeEvent, NameRecord } from "@koi/core";
import { compositeKey } from "@koi/name-resolution";
import type { NexusNameRecord } from "./nexus-rpc.js";
import { mapNexusBinding } from "./nexus-rpc.js";

// ---------------------------------------------------------------------------
// Projection state
// ---------------------------------------------------------------------------

/** Mutable local projection of Nexus ANS records. */
export interface NameProjection {
  readonly records: Map<string, NameRecord>;
  readonly aliases: Map<string, string>;
}

/** Create an empty projection. */
export function createProjection(): NameProjection {
  return { records: new Map(), aliases: new Map() };
}

// ---------------------------------------------------------------------------
// Wire → domain mapping
// ---------------------------------------------------------------------------

/**
 * Map a Nexus wire record to a domain NameRecord.
 * Returns undefined if the binding cannot be mapped.
 */
export function mapNexusRecord(nexusRecord: NexusNameRecord): NameRecord | undefined {
  const binding = mapNexusBinding(nexusRecord);
  if (binding === undefined) return undefined;

  return Object.freeze({
    name: nexusRecord.name,
    binding,
    scope: nexusRecord.scope as ForgeScope,
    aliases: Object.freeze([...nexusRecord.aliases]),
    registeredAt: nexusRecord.registered_at,
    expiresAt: nexusRecord.expires_at,
    registeredBy: nexusRecord.registered_by,
  });
}

// ---------------------------------------------------------------------------
// Projection mutations
// ---------------------------------------------------------------------------

/**
 * Diff a full Nexus listing against the local projection and apply changes.
 *
 * Emits "registered" for new records, "unregistered" for removed records,
 * and "renewed" for records whose expiresAt changed.
 */
export function applyList(
  projection: NameProjection,
  nexusRecords: readonly NexusNameRecord[],
  maxEntries: number,
): readonly NameChangeEvent[] {
  const events: NameChangeEvent[] = [];
  const remoteKeys = new Set<string>();

  for (const nexusRecord of nexusRecords) {
    if (
      projection.records.size >= maxEntries &&
      !projection.records.has(compositeKey(nexusRecord.scope as ForgeScope, nexusRecord.name))
    ) {
      continue;
    }

    const record = mapNexusRecord(nexusRecord);
    if (record === undefined) continue;

    const key = compositeKey(record.scope, record.name);
    remoteKeys.add(key);

    const existing = projection.records.get(key);

    if (existing === undefined) {
      // New record
      projection.records.set(key, record);
      insertAliases(projection, record);
      events.push({
        kind: "registered",
        name: record.name,
        scope: record.scope,
        binding: record.binding,
      });
    } else if (existing.expiresAt !== record.expiresAt) {
      // TTL changed — treat as renewal
      projection.records.set(key, record);
      events.push({
        kind: "renewed",
        name: record.name,
        scope: record.scope,
        binding: record.binding,
      });
    }
    // Otherwise: no change, skip
  }

  // Detect removed records
  for (const [key, record] of projection.records) {
    if (!remoteKeys.has(key)) {
      removeRecord(projection, key, record);
      events.push({
        kind: "unregistered",
        name: record.name,
        scope: record.scope,
        binding: record.binding,
      });
    }
  }

  return events;
}

/**
 * Apply a single registration to the local projection.
 * Called after a successful write RPC to keep projection consistent.
 */
export function applyRegister(
  projection: NameProjection,
  record: NameRecord,
): readonly NameChangeEvent[] {
  const key = compositeKey(record.scope, record.name);
  projection.records.set(key, record);
  insertAliases(projection, record);
  return [{ kind: "registered", name: record.name, scope: record.scope, binding: record.binding }];
}

/**
 * Apply a single unregistration to the local projection.
 * Called after a successful deregister RPC.
 */
export function applyUnregister(
  projection: NameProjection,
  name: string,
  scope: ForgeScope,
): readonly NameChangeEvent[] {
  const key = compositeKey(scope, name);
  const record = projection.records.get(key);
  if (record === undefined) return [];
  removeRecord(projection, key, record);
  return [{ kind: "unregistered", name, scope, binding: record.binding }];
}

/**
 * Apply a TTL renewal to the local projection.
 * Called after a successful renew RPC.
 */
export function applyRenew(
  projection: NameProjection,
  name: string,
  scope: ForgeScope,
  newExpiresAt: number,
): readonly NameChangeEvent[] {
  const key = compositeKey(scope, name);
  const existing = projection.records.get(key);
  if (existing === undefined) return [];

  const updated = Object.freeze({ ...existing, expiresAt: newExpiresAt });
  projection.records.set(key, updated);
  return [{ kind: "renewed", name, scope, binding: existing.binding }];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Insert alias mappings for a record. */
function insertAliases(projection: NameProjection, record: NameRecord): void {
  const canonicalKey = compositeKey(record.scope, record.name);
  for (const alias of record.aliases) {
    projection.aliases.set(compositeKey(record.scope, alias), canonicalKey);
  }
}

/** Remove a record and its alias mappings from the projection. */
function removeRecord(projection: NameProjection, key: string, record: NameRecord): void {
  for (const alias of record.aliases) {
    projection.aliases.delete(compositeKey(record.scope, alias));
  }
  projection.records.delete(key);
}
