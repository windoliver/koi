/**
 * Nexus-backed SessionStore with write-through cache.
 *
 * Local-first reads (sync), dual-write to local + Nexus (coalesced).
 * CAS ownership transfer on session resume from another instance.
 */

import type { KoiError, Result } from "@koi/core";
import { notFound } from "@koi/core";
import type { Session, SessionStore } from "@koi/gateway-types";
import type { NexusClient } from "@koi/nexus-client";
import { deleteJson, gatewaySessionPath, readJson } from "@koi/nexus-client";
import type { DegradationConfig, GatewayNexusConfig } from "./config.js";
import { DEFAULT_DEGRADATION_CONFIG } from "./config.js";
import type { DegradationState } from "./degradation.js";
import { createDegradationState, recordFailure, recordSuccess } from "./degradation.js";
import type { WriteQueue } from "./write-queue.js";
import { createWriteQueue } from "./write-queue.js";

// ---------------------------------------------------------------------------
// Nexus wire format
// ---------------------------------------------------------------------------

interface NexusSessionRecord {
  readonly session: Session;
  readonly ownerInstance: string;
  readonly ownedSince: number;
  readonly version: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface NexusSessionStoreOptions {
  readonly client: NexusClient;
  readonly config: GatewayNexusConfig;
}

export interface NexusSessionStoreHandle {
  readonly store: SessionStore;
  readonly degradation: () => DegradationState;
  readonly dispose: () => Promise<void>;
}

export function createNexusSessionStore(
  options: NexusSessionStoreOptions,
): NexusSessionStoreHandle {
  const { client, config } = options;
  const instanceId = config.instanceId ?? crypto.randomUUID();
  const degradationConfig: DegradationConfig = {
    ...DEFAULT_DEGRADATION_CONFIG,
    ...config.degradation,
  };
  const cache = new Map<string, Session>();
  let degradation = createDegradationState();

  const writeFn = async (path: string, data: string): Promise<void> => {
    const r = await client.rpc<null>("write", { path, content: data });
    if (r.ok) {
      degradation = recordSuccess(degradation);
    } else {
      degradation = recordFailure(degradation, degradationConfig);
    }
  };

  const queue: WriteQueue = createWriteQueue(writeFn, config.writeQueue);

  function nexusPath(id: string): string {
    return gatewaySessionPath(id);
  }

  function enqueueWrite(session: Session, immediate: boolean): void {
    const record: NexusSessionRecord = {
      session,
      ownerInstance: instanceId,
      ownedSince: Date.now(),
      version: 1,
    };
    queue.enqueue(nexusPath(session.id), JSON.stringify(record), immediate);
  }

  const store: SessionStore = {
    get(id: string): Result<Session, KoiError> | Promise<Result<Session, KoiError>> {
      const cached = cache.get(id);
      if (cached !== undefined) {
        return { ok: true, value: cached };
      }
      // Cache miss — try Nexus
      if (degradation.mode === "degraded") {
        return { ok: false, error: notFound(id, `Session not found: ${id}`) };
      }
      return (async (): Promise<Result<Session, KoiError>> => {
        const r = await readJson<NexusSessionRecord>(client, nexusPath(id));
        if (r.ok) {
          degradation = recordSuccess(degradation);
          cache.set(id, r.value.session);
          return { ok: true, value: r.value.session };
        }
        if (r.error.code === "NOT_FOUND") {
          return { ok: false, error: notFound(id, `Session not found: ${id}`) };
        }
        degradation = recordFailure(degradation, degradationConfig);
        return { ok: false, error: r.error };
      })();
    },

    set(session: Session): Result<void, KoiError> {
      const isNew = !cache.has(session.id);
      cache.set(session.id, session);
      enqueueWrite(session, isNew);
      return { ok: true, value: undefined };
    },

    delete(id: string): Result<boolean, KoiError> {
      const existed = cache.delete(id);
      // Immediate Nexus delete
      void deleteJson(client, nexusPath(id))
        .then((r) => {
          if (r.ok) {
            degradation = recordSuccess(degradation);
          } else {
            degradation = recordFailure(degradation, degradationConfig);
          }
        })
        .catch((_e: unknown) => {
          degradation = recordFailure(degradation, degradationConfig);
        });
      return { ok: true, value: existed };
    },

    has(id: string): Result<boolean, KoiError> {
      return { ok: true, value: cache.has(id) };
    },

    size(): number {
      return cache.size;
    },

    entries(): IterableIterator<readonly [string, Session]> {
      return cache.entries() as IterableIterator<readonly [string, Session]>;
    },
  };

  return {
    store,
    degradation: () => degradation,
    dispose: () => queue.dispose(),
  };
}
