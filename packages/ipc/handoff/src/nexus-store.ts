/**
 * NexusHandoffStore — persistent handoff envelope storage via Nexus JSON-RPC 2.0.
 *
 * Each envelope is stored at `{basePath}/{id}.json` as self-contained JSON.
 * Search is implemented client-side: glob all files, read in parallel, filter.
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
import { agentId, handoffId } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusClient } from "@koi/nexus-client";
import { conflictError, expiredError, internalError, notFoundError } from "./errors.js";
import type { HandoffStore, HandoffStoreConfig } from "./store.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusHandoffStoreConfig extends HandoffStoreConfig {
  /** Nexus server base URL (e.g., "http://localhost:2026"). */
  readonly baseUrl: string;
  /** Nexus API key for authentication. */
  readonly apiKey: string;
  /** Storage path prefix. Default: "/handoffs". */
  readonly basePath?: string | undefined;
  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/** Default TTL: 24 hours. */
const DEFAULT_TTL_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rebrandEnvelope(raw: HandoffEnvelope): HandoffEnvelope {
  return {
    ...raw,
    id: handoffId(raw.id),
    from: agentId(raw.from),
    to: agentId(raw.to),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusHandoffStore(config: NexusHandoffStoreConfig): HandoffStore {
  const basePath = config.basePath ?? "/handoffs";
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const client: NexusClient = createNexusClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetch: config.fetch,
  });

  // let justified: mutable registry unsubscribe callback
  let registryUnsubscribe: (() => void) | undefined;

  function envelopePath(id: string): string {
    return `${basePath}/${id}.json`;
  }

  async function rpc<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    return client.rpc<T>(method, params);
  }

  function isExpired(envelope: HandoffEnvelope): boolean {
    return envelope.createdAt + ttlMs < Date.now();
  }

  // -- HandoffStore methods --------------------------------------------------

  const put = async (envelope: HandoffEnvelope): Promise<Result<void, KoiError>> => {
    // Check existence first for CONFLICT semantics
    const existsResult = await rpc<boolean>("exists", { path: envelopePath(envelope.id) });
    if (!existsResult.ok) return existsResult;
    if (existsResult.value) {
      return { ok: false, error: conflictError(envelope.id) };
    }

    const writeResult = await rpc<void>("write", {
      path: envelopePath(envelope.id),
      content: JSON.stringify(envelope),
    });
    if (!writeResult.ok) return writeResult;
    return { ok: true, value: undefined };
  };

  const get = async (id: HandoffId): Promise<Result<HandoffEnvelope, KoiError>> => {
    const existsResult = await rpc<boolean>("exists", { path: envelopePath(id) });
    if (!existsResult.ok) return existsResult;
    if (!existsResult.value) {
      return { ok: false, error: notFoundError(id) };
    }

    const readResult = await rpc<string>("read", { path: envelopePath(id) });
    if (!readResult.ok) return readResult;

    try {
      const envelope = rebrandEnvelope(JSON.parse(readResult.value) as HandoffEnvelope);
      if (isExpired(envelope)) {
        return { ok: false, error: expiredError(id) };
      }
      return { ok: true, value: envelope };
    } catch {
      return {
        ok: false,
        error: internalError(`Corrupt handoff envelope data: ${id}`),
      };
    }
  };

  const transition = async (
    id: HandoffId,
    from: HandoffStatus,
    to: HandoffStatus,
  ): Promise<Result<HandoffEnvelope, KoiError>> => {
    // Read-compare-write with post-write verification to detect concurrent transitions
    const readResult = await rpc<string>("read", { path: envelopePath(id) });
    if (!readResult.ok) {
      return { ok: false, error: notFoundError(id) };
    }

    try {
      const envelope = rebrandEnvelope(JSON.parse(readResult.value) as HandoffEnvelope);
      if (envelope.status !== from) {
        return { ok: false, error: notFoundError(id) };
      }

      const updated: HandoffEnvelope = { ...envelope, status: to };
      const writeResult = await rpc<void>("write", {
        path: envelopePath(id),
        content: JSON.stringify(updated),
      });
      if (!writeResult.ok) return writeResult;

      // Post-write verification: re-read to detect if a concurrent transition overwrote ours
      const verifyResult = await rpc<string>("read", { path: envelopePath(id) });
      if (verifyResult.ok) {
        try {
          const current = JSON.parse(verifyResult.value) as HandoffEnvelope;
          if (current.status !== to) {
            // Another process transitioned after our write — report conflict
            return { ok: false, error: conflictError(id) };
          }
        } catch {
          // Parse failure on verify — treat as success since our write succeeded
        }
      }

      return { ok: true, value: updated };
    } catch {
      return {
        ok: false,
        error: internalError(`Failed to parse handoff envelope: ${id}`),
      };
    }
  };

  const listByAgent = async (
    aid: AgentId,
  ): Promise<Result<readonly HandoffEnvelope[], KoiError>> => {
    const globResult = await rpc<readonly string[]>("glob", {
      pattern: `${basePath}/*.json`,
    });
    if (!globResult.ok) return globResult;

    const readResults = await Promise.all(
      globResult.value.map((fp: string) => rpc<string>("read", { path: fp })),
    );

    const matched: HandoffEnvelope[] = [];
    for (const readResult of readResults) {
      if (!readResult.ok) continue;
      try {
        const envelope = rebrandEnvelope(JSON.parse(readResult.value) as HandoffEnvelope);
        if (envelope.from === aid || envelope.to === aid) {
          matched.push(envelope);
        }
      } catch {
        // Skip corrupt files
      }
    }

    return { ok: true, value: matched };
  };

  const findPendingForAgent = async (
    aid: AgentId,
  ): Promise<Result<HandoffEnvelope | undefined, KoiError>> => {
    const globResult = await rpc<readonly string[]>("glob", {
      pattern: `${basePath}/*.json`,
    });
    if (!globResult.ok) return globResult;

    const readResults = await Promise.all(
      globResult.value.map((fp: string) => rpc<string>("read", { path: fp })),
    );

    const pending: HandoffEnvelope[] = [];
    for (const readResult of readResults) {
      if (!readResult.ok) continue;
      try {
        const envelope = rebrandEnvelope(JSON.parse(readResult.value) as HandoffEnvelope);
        if (
          envelope.to === aid &&
          (envelope.status === "pending" || envelope.status === "injected") &&
          !isExpired(envelope)
        ) {
          pending.push(envelope);
        }
      } catch {
        // Skip corrupt files
      }
    }

    // Sort by createdAt ascending (oldest first)
    pending.sort((a, b) => a.createdAt - b.createdAt);
    return { ok: true, value: pending[0] };
  };

  const remove = async (id: HandoffId): Promise<Result<boolean, KoiError>> => {
    const existsResult = await rpc<boolean>("exists", { path: envelopePath(id) });
    if (!existsResult.ok) return existsResult;
    if (!existsResult.value) {
      return { ok: true, value: false };
    }

    const deleteResult = await rpc<void>("delete", { path: envelopePath(id) });
    if (!deleteResult.ok) return deleteResult;
    return { ok: true, value: true };
  };

  const removeByAgent = async (aid: AgentId): Promise<Result<void, KoiError>> => {
    const globResult = await rpc<readonly string[]>("glob", {
      pattern: `${basePath}/*.json`,
    });
    if (!globResult.ok) return globResult;

    const readResults = await Promise.all(
      globResult.value.map((fp: string) => rpc<string>("read", { path: fp })),
    );

    const toDelete: string[] = [];
    for (const [i, readResult] of readResults.entries()) {
      if (!readResult.ok) continue;
      try {
        const envelope = JSON.parse(readResult.value) as HandoffEnvelope;
        if (envelope.from === aid || envelope.to === aid) {
          const filePath = globResult.value[i];
          if (filePath !== undefined) {
            toDelete.push(filePath);
          }
        }
      } catch {
        // Skip corrupt files
      }
    }

    await Promise.all(toDelete.map((path) => rpc<void>("delete", { path })));
    return { ok: true, value: undefined };
  };

  function bindRegistry(registry: AgentRegistry): void {
    registryUnsubscribe?.();
    registryUnsubscribe = registry.watch((event: RegistryEvent) => {
      if (event.kind === "transitioned" && event.to === "terminated") {
        void removeByAgent(event.agentId);
      } else if (event.kind === "deregistered") {
        void removeByAgent(event.agentId);
      }
    });
  }

  function dispose(): void {
    registryUnsubscribe?.();
    registryUnsubscribe = undefined;
  }

  return {
    put,
    get,
    transition,
    listByAgent,
    findPendingForAgent,
    remove,
    removeByAgent,
    bindRegistry,
    dispose,
  };
}
