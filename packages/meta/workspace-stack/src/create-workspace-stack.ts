/**
 * Main factory for the workspace stack.
 *
 * Creates raw Nexus-backed pieces (backend, enforcer, retriever) that
 * callers like @koi/governance compose into providers and middleware.
 *
 * This package does NOT create providers or wrap with enforcement —
 * governance owns that composition chain.
 *
 * Composition:
 *   1. Validate config at boundary
 *   2. Create shared NexusClient
 *   3. Create raw Nexus filesystem backend
 *   4. If permissions enabled: create scope enforcer
 *   5. If search enabled: create scope-filtered retriever
 */

import type { AgentId, KoiError, Result } from "@koi/core";
import { createNexusFileSystem } from "@koi/filesystem-nexus";
import { createNexusClient } from "@koi/nexus-client";
import { createNexusPermissionBackend, createNexusScopeEnforcer } from "@koi/permissions-nexus";
import { createNexusSearch } from "@koi/search-nexus";
import type { Retriever, SearchPage, SearchQuery } from "@koi/search-provider";
import type { WorkspaceStackBundle, WorkspaceStackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultScopeRoot(agentId: AgentId): string {
  return `/agents/${agentId}/workspace`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate required fields at system boundary. Throws on invalid config. */
function validateConfig(config: WorkspaceStackConfig): void {
  if (!config.nexusBaseUrl) {
    throw new Error("WorkspaceStackConfig.nexusBaseUrl is required");
  }
  if (!config.nexusApiKey) {
    throw new Error("WorkspaceStackConfig.nexusApiKey is required");
  }
  if (!config.agentId) {
    throw new Error("WorkspaceStackConfig.agentId is required");
  }
}

// ---------------------------------------------------------------------------
// Scope-filtered retriever
// ---------------------------------------------------------------------------

/**
 * Wrap a retriever with a post-filter that removes results outside `scopeRoot`.
 *
 * The Nexus search REST API does not support path-prefix scoping at the query
 * level, so we filter on the client side using `metadata.path`. Results whose
 * `metadata.path` does not start with `scopeRoot` are dropped. The returned
 * `total` is adjusted to reflect the filtered set.
 *
 * Exported for testing — not part of the public API.
 */
export function createScopedRetriever(inner: Retriever, scopeRoot: string): Retriever {
  // Ensure the prefix ends with "/" so "/agents/a" doesn't match "/agents/ab/…"
  const prefix = scopeRoot.endsWith("/") ? scopeRoot : `${scopeRoot}/`;

  return {
    retrieve: async (query: SearchQuery): Promise<Result<SearchPage, KoiError>> => {
      const result = await inner.retrieve(query);
      if (!result.ok) {
        return result;
      }

      const page = result.value;
      const filtered = page.results.filter((r) => {
        const path = r.metadata.path;
        return typeof path === "string" && (path === scopeRoot || path.startsWith(prefix));
      });

      return {
        ok: true,
        value: {
          results: filtered,
          total: filtered.length,
          hasMore: page.hasMore,
          ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create raw Nexus-backed workspace pieces from configuration.
 *
 * Returns { backend, enforcer, retriever }:
 * - backend: raw NexusFileSystem (caller wraps with enforcement/scope)
 * - enforcer: ScopeEnforcer (if permissions enabled) — pass to governance
 * - retriever: Retriever (if search enabled) — pass to FileSystemProvider
 */
export function createWorkspaceStack(config: WorkspaceStackConfig): WorkspaceStackBundle {
  validateConfig(config);

  // 1. Shared NexusClient (JSON-RPC)
  const client = createNexusClient({
    baseUrl: config.nexusBaseUrl,
    apiKey: config.nexusApiKey,
    fetch: config.fetch,
  });

  // 2. Raw Nexus filesystem backend
  const scopeRoot = config.scope?.root ?? defaultScopeRoot(config.agentId);
  const backend = createNexusFileSystem({ client, basePath: scopeRoot });

  // 3. Permission enforcement (optional, default: enabled)
  const permissionsEnabled = config.permissions?.enabled !== false;
  const enforcer = permissionsEnabled
    ? createNexusScopeEnforcer({
        backend: createNexusPermissionBackend({ client }),
      })
    : undefined;

  // 4. Search retriever (optional, default: enabled)
  //    Scoped via post-filter on metadata.path to match the filesystem scopeRoot.
  const searchEnabled = config.search?.enabled !== false;
  const retriever = searchEnabled
    ? createScopedRetriever(
        createNexusSearch({
          baseUrl: config.nexusBaseUrl,
          apiKey: config.nexusApiKey,
          fetchFn: config.fetch,
          ...(config.search?.minScore !== undefined ? { minScore: config.search.minScore } : {}),
        }).retriever,
        scopeRoot,
      )
    : undefined;

  return {
    backend,
    ...(enforcer !== undefined ? { enforcer } : {}),
    ...(retriever !== undefined ? { retriever } : {}),
  };
}
