/**
 * HandoffStore — interface + in-memory implementation with CAS status
 * transitions, TTL expiration, conflict detection, and registry-bound cleanup.
 */

import type {
  AgentId,
  AgentRegistry,
  HandoffEnvelope,
  HandoffId,
  HandoffStatus,
  KoiError,
  RegistryEvent,
  Result,
} from "@koi/core";
import { conflictError, expiredError, notFoundError } from "./errors.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Base configuration for all HandoffStore backends. */
export interface HandoffStoreConfig {
  /** Time-to-live for envelopes in milliseconds. Default: 86_400_000 (24h). */
  readonly ttlMs?: number | undefined;
}

/** Default TTL: 24 hours. */
const DEFAULT_TTL_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HandoffStore {
  readonly put: (
    envelope: HandoffEnvelope,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
  readonly get: (
    id: HandoffId,
  ) => Result<HandoffEnvelope, KoiError> | Promise<Result<HandoffEnvelope, KoiError>>;
  /** CAS status transition. Returns updated envelope or error on mismatch. */
  readonly transition: (
    id: HandoffId,
    from: HandoffStatus,
    to: HandoffStatus,
  ) => Result<HandoffEnvelope, KoiError> | Promise<Result<HandoffEnvelope, KoiError>>;
  readonly listByAgent: (
    agentId: AgentId,
  ) =>
    | Result<readonly HandoffEnvelope[], KoiError>
    | Promise<Result<readonly HandoffEnvelope[], KoiError>>;
  readonly findPendingForAgent: (
    agentId: AgentId,
  ) =>
    | Result<HandoffEnvelope | undefined, KoiError>
    | Promise<Result<HandoffEnvelope | undefined, KoiError>>;
  readonly remove: (
    id: HandoffId,
  ) => Result<boolean, KoiError> | Promise<Result<boolean, KoiError>>;
  readonly removeByAgent: (
    agentId: AgentId,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
  /** Bind to AgentRegistry — removes envelopes when agents terminate. */
  readonly bindRegistry: (registry: AgentRegistry) => void;
  readonly dispose: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory factory
// ---------------------------------------------------------------------------

export function createInMemoryHandoffStore(config?: HandoffStoreConfig): HandoffStore {
  const envelopes = new Map<HandoffId, HandoffEnvelope>();
  const ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;

  // let justified: mutable registry unsubscribe callback
  let registryUnsubscribe: (() => void) | undefined;

  function isExpired(envelope: HandoffEnvelope): boolean {
    return envelope.createdAt + ttlMs < Date.now();
  }

  function put(envelope: HandoffEnvelope): Result<void, KoiError> {
    if (envelopes.has(envelope.id)) {
      return { ok: false, error: conflictError(envelope.id) };
    }
    envelopes.set(envelope.id, envelope);
    return { ok: true, value: undefined };
  }

  function get(id: HandoffId): Result<HandoffEnvelope, KoiError> {
    const envelope = envelopes.get(id);
    if (envelope === undefined) {
      return { ok: false, error: notFoundError(id) };
    }
    if (isExpired(envelope)) {
      const expired: HandoffEnvelope = { ...envelope, status: "expired" };
      envelopes.set(id, expired);
      return { ok: false, error: expiredError(id) };
    }
    return { ok: true, value: envelope };
  }

  function transition(
    id: HandoffId,
    from: HandoffStatus,
    to: HandoffStatus,
  ): Result<HandoffEnvelope, KoiError> {
    const existing = envelopes.get(id);
    if (existing === undefined || existing.status !== from) {
      return { ok: false, error: notFoundError(id) };
    }

    const updated: HandoffEnvelope = { ...existing, status: to };
    envelopes.set(id, updated);
    return { ok: true, value: updated };
  }

  function listByAgent(aid: AgentId): Result<readonly HandoffEnvelope[], KoiError> {
    const results = [...envelopes.values()].filter((e) => e.from === aid || e.to === aid);
    return { ok: true, value: results };
  }

  function remove(id: HandoffId): Result<boolean, KoiError> {
    return { ok: true, value: envelopes.delete(id) };
  }

  function removeByAgent(aid: AgentId): Result<void, KoiError> {
    for (const [id, envelope] of envelopes) {
      if (envelope.from === aid || envelope.to === aid) {
        envelopes.delete(id);
      }
    }
    return { ok: true, value: undefined };
  }

  function findPendingForAgent(aid: AgentId): Result<HandoffEnvelope | undefined, KoiError> {
    const pending: HandoffEnvelope[] = [];
    for (const envelope of envelopes.values()) {
      if (
        envelope.to === aid &&
        (envelope.status === "pending" || envelope.status === "injected")
      ) {
        if (!isExpired(envelope)) {
          pending.push(envelope);
        } else {
          // Mark expired in-place
          envelopes.set(envelope.id, { ...envelope, status: "expired" });
        }
      }
    }
    // Sort by createdAt ascending (oldest first)
    pending.sort((a, b) => a.createdAt - b.createdAt);
    return { ok: true, value: pending[0] };
  }

  function bindRegistry(registry: AgentRegistry): void {
    registryUnsubscribe?.();
    registryUnsubscribe = registry.watch((event: RegistryEvent) => {
      if (event.kind === "transitioned" && event.to === "terminated") {
        removeByAgent(event.agentId);
      } else if (event.kind === "deregistered") {
        removeByAgent(event.agentId);
      }
    });
  }

  function dispose(): void {
    registryUnsubscribe?.();
    registryUnsubscribe = undefined;
    envelopes.clear();
  }

  return {
    put,
    get,
    transition,
    listByAgent,
    remove,
    removeByAgent,
    findPendingForAgent,
    bindRegistry,
    dispose,
  };
}

/**
 * @deprecated Use `createInMemoryHandoffStore()` instead.
 * Kept for backward compatibility — will be removed in a future release.
 */
export function createHandoffStore(config?: HandoffStoreConfig): HandoffStore {
  return createInMemoryHandoffStore(config);
}
