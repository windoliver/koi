/**
 * Test helpers for the delegation package.
 *
 * Provides async registry wrappers and cleanup utilities for testing
 * code paths that depend on async RevocationRegistry implementations.
 */

import type {
  AgentId,
  DelegationGrant,
  DelegationId,
  KoiError,
  Result,
  RevocationRegistry,
} from "@koi/core";
import { agentId } from "@koi/core";
import { createGrant } from "./grant.js";
import type { InMemoryRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Async revocation registry (wraps sync ops in Promise.resolve)
// ---------------------------------------------------------------------------

/**
 * Creates an async RevocationRegistry that wraps sync operations in
 * Promise.resolve(). Tests code paths where the registry is backed by
 * an async store (e.g., network).
 */
export function createAsyncRevocationRegistry(): RevocationRegistry & {
  readonly revokedIds: () => ReadonlySet<DelegationId>;
} {
  const revoked = new Set<DelegationId>();
  return {
    isRevoked: (id: DelegationId): Promise<boolean> => Promise.resolve(revoked.has(id)),
    revoke: (id: DelegationId): Promise<void> => {
      revoked.add(id);
      return Promise.resolve();
    },
    revokedIds: () => new Set(revoked),
  };
}

// ---------------------------------------------------------------------------
// Registry cleanup tracker
// ---------------------------------------------------------------------------

/**
 * Tracks disposable registries created during a test for cleanup in afterEach.
 * Prevents timer leaks from InMemoryRegistry setInterval.
 */
export function createRegistryCleanup(): {
  readonly track: (registry: InMemoryRegistry) => InMemoryRegistry;
  readonly disposeAll: () => void;
} {
  const tracked: InMemoryRegistry[] = [];

  return {
    track: (registry: InMemoryRegistry): InMemoryRegistry => {
      tracked.push(registry);
      return registry;
    },
    disposeAll: () => {
      for (const r of tracked) {
        r.dispose();
      }
      tracked.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Grant factory for tests
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-secret-key-32-bytes-minimum";

/** Creates a grant for testing, throwing if creation fails. */
export function mustCreateGrant(
  overrides?: Partial<{
    readonly issuerId: AgentId;
    readonly delegateeId: AgentId;
    readonly scope: DelegationGrant["scope"];
    readonly maxChainDepth: number;
    readonly ttlMs: number;
    readonly secret: string;
  }>,
): DelegationGrant {
  const result: Result<DelegationGrant, KoiError> = createGrant({
    issuerId: overrides?.issuerId ?? agentId("agent-1"),
    delegateeId: overrides?.delegateeId ?? agentId("agent-2"),
    scope: overrides?.scope ?? { permissions: { allow: ["read_file", "write_file"] } },
    maxChainDepth: overrides?.maxChainDepth ?? 3,
    ttlMs: overrides?.ttlMs ?? 3600000,
    secret: overrides?.secret ?? TEST_SECRET,
  });
  if (!result.ok) throw new Error(`mustCreateGrant failed: ${result.error.message}`);
  return result.value;
}
