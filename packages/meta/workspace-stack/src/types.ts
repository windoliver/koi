/**
 * Core types for the @koi/workspace-stack L3 bundle.
 *
 * workspace-stack is a backend factory — it creates the raw Nexus-backed
 * pieces (backend, enforcer, retriever) that callers like @koi/governance
 * compose into providers. It does NOT create providers itself.
 */

import type { AgentId, FileSystemBackend, ScopeEnforcer } from "@koi/core";
import type { Retriever } from "@koi/search-provider";

/** Configuration for createWorkspaceStack(). */
export interface WorkspaceStackConfig {
  /** Nexus server base URL (e.g. "http://localhost:2026"). */
  readonly nexusBaseUrl: string;
  /** Nexus API key for authentication. */
  readonly nexusApiKey: string;
  /** Agent identity — used for permission checks and default scope root. */
  readonly agentId: AgentId;

  /** Filesystem scope restriction. */
  readonly scope?:
    | {
        /** Root path for scoped filesystem. Default: `/agents/${agentId}/workspace`. */
        readonly root?: string | undefined;
      }
    | undefined;

  /** Search configuration. */
  readonly search?:
    | {
        /** Enable semantic search retriever. Default: true. */
        readonly enabled?: boolean | undefined;
        /** Minimum score threshold for search results. */
        readonly minScore?: number | undefined;
      }
    | undefined;

  /** Permission enforcement configuration. */
  readonly permissions?:
    | {
        /** Enable Nexus ReBAC permission checks. Default: true. */
        readonly enabled?: boolean | undefined;
      }
    | undefined;

  /** Injectable fetch for testing. Default: globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Return type of createWorkspaceStack().
 *
 * Raw pieces for callers to compose. Governance takes `backend` as
 * `backends.filesystem` and `enforcer` as the scope enforcer.
 * The `retriever` can be passed to `createFileSystemProvider({ retriever })`.
 */
export interface WorkspaceStackBundle {
  /** Raw Nexus-backed filesystem backend (NOT enforced — caller wraps). */
  readonly backend: FileSystemBackend;
  /** The scope enforcer, if permissions are enabled. Pass to governance. */
  readonly enforcer?: ScopeEnforcer | undefined;
  /** Semantic search retriever, if search is enabled. Pass to FileSystemProvider. */
  readonly retriever?: Retriever | undefined;
}
