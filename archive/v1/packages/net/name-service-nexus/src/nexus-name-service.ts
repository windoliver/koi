/**
 * Nexus-backed ANS backend implementation.
 *
 * Uses Nexus as the authoritative store for name records. Maintains a local
 * in-memory projection for fast reads, synchronized via periodic polling.
 * Write operations hit Nexus first, then update the local projection
 * (write-then-project pattern).
 *
 * L2 package — imports only from @koi/core (L0) and L0u packages.
 */

import type {
  AnsConfig,
  ForgeScope,
  KoiError,
  NameChangeEvent,
  NameQuery,
  NameRecord,
  NameRegistration,
  NameResolution,
  NameServiceBackend,
  NameSuggestion,
  Result,
} from "@koi/core";
import { DEFAULT_ANS_CONFIG, RETRYABLE_DEFAULTS } from "@koi/core";
import { computeSuggestions, resolveByScope, validateName } from "@koi/name-resolution";
import type { NexusNameServiceConfig } from "./config.js";
import { DEFAULT_NEXUS_NAME_SERVICE_CONFIG, validateNexusNameServiceConfig } from "./config.js";
import { nexusAnsDeregister, nexusAnsList, nexusAnsRegister, nexusAnsRenew } from "./nexus-rpc.js";
import {
  applyList,
  applyRegister,
  applyRenew,
  applyUnregister,
  createProjection,
  mapNexusRecord,
} from "./projection.js";

// ---------------------------------------------------------------------------
// Config merging
// ---------------------------------------------------------------------------

/** Merge user ANS config with defaults. */
function mergeAnsConfig(partial?: Partial<AnsConfig>): AnsConfig {
  if (partial === undefined) return DEFAULT_ANS_CONFIG;
  return { ...DEFAULT_ANS_CONFIG, ...partial };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Nexus-backed ANS backend.
 *
 * Performs eager warmup by listing all names from Nexus at startup.
 * Starts a poll timer to keep the local projection in sync.
 *
 * @param config - Nexus connection and sync configuration.
 */
export async function createNexusNameService(
  config: NexusNameServiceConfig,
): Promise<NameServiceBackend> {
  // Validate config upfront
  const configResult = validateNexusNameServiceConfig(config);
  if (!configResult.ok) {
    throw new Error(`Invalid NexusNameServiceConfig: ${configResult.error.message}`, {
      cause: configResult.error,
    });
  }

  const ansConfig = mergeAnsConfig(config.ansConfig);
  const maxEntries = config.maxEntries ?? DEFAULT_NEXUS_NAME_SERVICE_CONFIG.maxEntries;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_NEXUS_NAME_SERVICE_CONFIG.pollIntervalMs;

  // Mutable internal state
  const projection = createProjection();
  // let: replaced on onChange/unsubscribe (immutable-set pattern)
  let listeners: ReadonlySet<(event: NameChangeEvent) => void> = new Set();
  // let: poll timer handle, cleared on dispose
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  // let: disposed flag to prevent operations after cleanup
  let disposed = false;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function notify(events: readonly NameChangeEvent[]): void {
    for (const event of events) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  /** Load all names from Nexus into the local projection. */
  async function loadProjection(): Promise<void> {
    const listResult = await nexusAnsList(config, config.zoneId);
    if (!listResult.ok) {
      throw new Error(
        `Failed to load names from Nexus during startup: ${listResult.error.message}`,
        { cause: listResult.error },
      );
    }
    const events = applyList(projection, listResult.value, maxEntries);
    notify(events);
  }

  /** Poll Nexus for changes and diff against the local projection. */
  async function poll(): Promise<void> {
    if (disposed) return;

    const listResult = await nexusAnsList(config, config.zoneId);
    if (!listResult.ok) return; // Silently skip failed polls

    const events = applyList(projection, listResult.value, maxEntries);
    notify(events);
  }

  // -------------------------------------------------------------------------
  // NameServiceBackend — Writer
  // -------------------------------------------------------------------------

  const register = async (
    registration: NameRegistration,
  ): Promise<Result<NameRecord, KoiError>> => {
    // Local validation first (no RPC on failure)
    const nameResult = validateName(registration.name);
    if (!nameResult.ok) return nameResult;

    const registrationAliases = registration.aliases ?? [];
    if (registrationAliases.length > ansConfig.maxAliasesPerName) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Too many aliases: ${registrationAliases.length} exceeds max ${ansConfig.maxAliasesPerName}`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    for (const alias of registrationAliases) {
      const aliasResult = validateName(alias);
      if (!aliasResult.ok) return aliasResult;
    }

    // Check local capacity
    if (projection.records.size >= maxEntries) {
      return {
        ok: false,
        error: {
          code: "RATE_LIMIT",
          message: `Maximum entries (${maxEntries}) reached`,
          retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
        },
      };
    }

    // RPC to Nexus
    const ttlMs = registration.ttlMs ?? ansConfig.defaultTtlMs;
    const rpcResult = await nexusAnsRegister(config, {
      name: registration.name,
      binding: registration.binding,
      scope: registration.scope,
      aliases: [...registrationAliases],
      ttl_ms: ttlMs > 0 ? ttlMs : undefined,
      registered_by: registration.registeredBy,
      zone_id: config.zoneId,
    });

    if (!rpcResult.ok) return rpcResult;

    // Map Nexus response to domain record
    const record = mapNexusRecord(rpcResult.value);
    if (record === undefined) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: "Nexus returned a record with an invalid binding",
          retryable: false,
        },
      };
    }

    // Write-then-project: update local projection immediately
    const events = applyRegister(projection, record);
    notify(events);

    return { ok: true, value: record };
  };

  const unregister = async (name: string, scope: ForgeScope): Promise<boolean> => {
    // Check local first
    const key = `${scope}:${name}`;
    if (!projection.records.has(key)) return false;

    // RPC to Nexus
    const rpcResult = await nexusAnsDeregister(config, name, scope);
    if (!rpcResult.ok) return false;

    // Write-then-project
    const events = applyUnregister(projection, name, scope);
    notify(events);

    return true;
  };

  const renew = async (
    name: string,
    scope: ForgeScope,
    ttlMs?: number,
  ): Promise<Result<NameRecord, KoiError>> => {
    // Check local first
    const key = `${scope}:${name}`;
    const existing = projection.records.get(key);
    if (existing === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Name "${name}" not found in scope "${scope}"`,
          retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          context: { name, scope },
        },
      };
    }

    // RPC to Nexus
    const rpcResult = await nexusAnsRenew(config, name, scope, ttlMs);
    if (!rpcResult.ok) return rpcResult;

    // Write-then-project
    const newExpiresAt = rpcResult.value.expires_at;
    const events = applyRenew(projection, name, scope, newExpiresAt);
    notify(events);

    const updated = projection.records.get(key);
    return { ok: true, value: updated ?? existing };
  };

  // -------------------------------------------------------------------------
  // NameServiceBackend — Reader (pure local reads)
  // -------------------------------------------------------------------------

  const resolve = (name: string, scope?: ForgeScope): Result<NameResolution, KoiError> => {
    return resolveByScope(name, scope, projection.records, projection.aliases);
  };

  const search = (query: NameQuery): readonly NameRecord[] => {
    const results: NameRecord[] = [];
    const limit = query.limit ?? ansConfig.maxRecords;

    for (const record of projection.records.values()) {
      if (results.length >= limit) break;

      // Skip expired
      if (record.expiresAt > 0 && Date.now() > record.expiresAt) continue;

      // Scope filter
      if (query.scope !== undefined && record.scope !== query.scope) continue;

      // Binding kind filter
      if (query.bindingKind !== undefined && record.binding.kind !== query.bindingKind) continue;

      // Text filter — match on name or aliases
      if (query.text !== undefined) {
        const text = query.text.toLowerCase();
        const nameMatches = record.name.includes(text);
        const aliasMatches = record.aliases.some((a) => a.includes(text));
        if (!nameMatches && !aliasMatches) continue;
      }

      results.push(record);
    }

    return Object.freeze(results);
  };

  const suggest = (name: string, scope?: ForgeScope): readonly NameSuggestion[] => {
    return computeSuggestions(name, scope, projection.records, ansConfig);
  };

  const onChange = (listener: (event: NameChangeEvent) => void): (() => void) => {
    listeners = new Set([...listeners, listener]);
    return () => {
      listeners = new Set([...listeners].filter((l) => l !== listener));
    };
  };

  const dispose = (): void => {
    disposed = true;
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    projection.records.clear();
    projection.aliases.clear();
    listeners = new Set();
  };

  // -------------------------------------------------------------------------
  // Startup: load projection + start poll timer
  // -------------------------------------------------------------------------

  await loadProjection();

  if (pollIntervalMs > 0) {
    pollTimer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
  }

  return {
    register,
    unregister,
    renew,
    resolve,
    search,
    suggest,
    onChange,
    dispose,
  };
}
