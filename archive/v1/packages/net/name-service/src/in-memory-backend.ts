/**
 * In-memory ANS backend.
 *
 * Factory function that returns a full NameServiceBackend with registration,
 * resolution, search, suggestions, TTL expiry, and event dispatch.
 */

import type {
  AnsConfig,
  ForgeScope,
  KoiError,
  NameBinding,
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
import {
  compositeKey,
  computeSuggestions,
  resolveByScope,
  validateName,
} from "@koi/name-resolution";
import { createExpiryScheduler } from "./expiry-scheduler.js";

/** Merge user config with defaults. */
function mergeConfig(partial?: Partial<AnsConfig>): AnsConfig {
  if (partial === undefined) return DEFAULT_ANS_CONFIG;
  return { ...DEFAULT_ANS_CONFIG, ...partial };
}

/** Check whether two bindings are structurally equal. */
function bindingsEqual(a: NameBinding, b: NameBinding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "agent" && b.kind === "agent") return a.agentId === b.agentId;
  if (a.kind === "brick" && b.kind === "brick") {
    return a.brickId === b.brickId && a.brickKind === b.brickKind;
  }
  return false;
}

/**
 * Create an in-memory ANS backend.
 *
 * @param partialConfig - Optional partial configuration (merged with defaults).
 */
export function createInMemoryNameService(partialConfig?: Partial<AnsConfig>): NameServiceBackend {
  const config = mergeConfig(partialConfig);

  // Internal mutable state
  const records = new Map<string, NameRecord>();
  const aliases = new Map<string, string>();
  const listeners = new Set<(event: NameChangeEvent) => void>();

  /** Emit a change event to all listeners synchronously. */
  const emit = (event: NameChangeEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  /** Handle record expiry — remove record and emit event. */
  const handleExpiry = (name: string, scope: ForgeScope): void => {
    const key = compositeKey(scope, name);
    const record = records.get(key);
    if (record === undefined) return;

    // Remove aliases
    for (const alias of record.aliases) {
      aliases.delete(compositeKey(scope, alias));
    }
    records.delete(key);

    emit({ kind: "expired", name, scope, binding: record.binding });
  };

  const scheduler = createExpiryScheduler(handleExpiry);

  // --- Writer ---

  const register = (registration: NameRegistration): Result<NameRecord, KoiError> => {
    // Validate canonical name
    const nameResult = validateName(registration.name);
    if (!nameResult.ok) return nameResult;

    // Validate aliases
    const registrationAliases = registration.aliases ?? [];
    if (registrationAliases.length > config.maxAliasesPerName) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Too many aliases: ${registrationAliases.length} exceeds max ${config.maxAliasesPerName}`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }

    for (const alias of registrationAliases) {
      const aliasResult = validateName(alias);
      if (!aliasResult.ok) return aliasResult;
    }

    // Check capacity
    if (records.size >= config.maxRecords) {
      return {
        ok: false,
        error: {
          code: "RATE_LIMIT",
          message: `Maximum records (${config.maxRecords}) reached`,
          retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
        },
      };
    }

    const key = compositeKey(registration.scope, registration.name);

    // Check for existing record — idempotent for same binding
    const existing = records.get(key);
    if (existing !== undefined) {
      if (bindingsEqual(existing.binding, registration.binding)) {
        return { ok: true, value: existing };
      }
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Name "${registration.name}" already registered in scope "${registration.scope}" with a different binding`,
          retryable: RETRYABLE_DEFAULTS.CONFLICT,
          context: { name: registration.name, scope: registration.scope },
        },
      };
    }

    // Check alias conflicts — aliases must not collide with existing canonical names or aliases
    for (const alias of registrationAliases) {
      const aliasKey = compositeKey(registration.scope, alias);
      if (records.has(aliasKey) || aliases.has(aliasKey)) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: `Alias "${alias}" conflicts with an existing name or alias in scope "${registration.scope}"`,
            retryable: RETRYABLE_DEFAULTS.CONFLICT,
            context: { alias, scope: registration.scope },
          },
        };
      }
    }

    // Also check if the canonical name conflicts with an existing alias
    if (aliases.has(key)) {
      return {
        ok: false,
        error: {
          code: "CONFLICT",
          message: `Name "${registration.name}" conflicts with an existing alias in scope "${registration.scope}"`,
          retryable: RETRYABLE_DEFAULTS.CONFLICT,
          context: { name: registration.name, scope: registration.scope },
        },
      };
    }

    const now = Date.now();
    const ttlMs = registration.ttlMs ?? config.defaultTtlMs;
    const expiresAt = ttlMs > 0 ? now + ttlMs : 0;

    const record: NameRecord = Object.freeze({
      name: registration.name,
      binding: registration.binding,
      scope: registration.scope,
      aliases: Object.freeze([...registrationAliases]),
      registeredAt: now,
      expiresAt,
      registeredBy: registration.registeredBy,
    });

    records.set(key, record);

    // Insert aliases
    for (const alias of registrationAliases) {
      aliases.set(compositeKey(registration.scope, alias), key);
    }

    // Schedule expiry
    if (ttlMs > 0) {
      scheduler.schedule(registration.name, registration.scope, ttlMs);
    }

    emit({
      kind: "registered",
      name: registration.name,
      scope: registration.scope,
      binding: registration.binding,
    });

    return { ok: true, value: record };
  };

  const unregister = (name: string, scope: ForgeScope): boolean => {
    const key = compositeKey(scope, name);
    const record = records.get(key);
    if (record === undefined) return false;

    // Cancel expiry timer
    scheduler.cancel(name, scope);

    // Remove aliases
    for (const alias of record.aliases) {
      aliases.delete(compositeKey(scope, alias));
    }

    records.delete(key);

    emit({ kind: "unregistered", name, scope, binding: record.binding });

    return true;
  };

  const renew = (name: string, scope: ForgeScope, ttlMs?: number): Result<NameRecord, KoiError> => {
    const key = compositeKey(scope, name);
    const existing = records.get(key);
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

    const effectiveTtl = ttlMs ?? config.defaultTtlMs;
    const now = Date.now();
    const newExpiresAt = effectiveTtl > 0 ? now + effectiveTtl : 0;

    const renewed: NameRecord = Object.freeze({
      ...existing,
      expiresAt: newExpiresAt,
    });

    records.set(key, renewed);

    // Reset timer
    scheduler.cancel(name, scope);
    if (effectiveTtl > 0) {
      scheduler.schedule(name, scope, effectiveTtl);
    }

    emit({ kind: "renewed", name, scope, binding: existing.binding });

    return { ok: true, value: renewed };
  };

  // --- Reader ---

  const resolve = (name: string, scope?: ForgeScope): Result<NameResolution, KoiError> => {
    return resolveByScope(name, scope, records, aliases);
  };

  const search = (query: NameQuery): readonly NameRecord[] => {
    const results: NameRecord[] = [];
    const limit = query.limit ?? config.maxRecords;

    for (const record of records.values()) {
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
    return computeSuggestions(name, scope, records, config);
  };

  const onChange = (listener: (event: NameChangeEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const dispose = (): void => {
    scheduler.dispose();
    records.clear();
    aliases.clear();
    listeners.clear();
  };

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
