/**
 * Internal types for agent discovery — source contracts and injectable I/O.
 */

import type {
  ExternalAgentDescriptor,
  ExternalAgentSource,
  ExternalAgentTransport,
  Result,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Discovery source — pluggable source contract
// ---------------------------------------------------------------------------

/** A pluggable source that discovers external agents from a specific origin. */
export interface DiscoverySource {
  readonly name: string;
  readonly discover: () => Promise<readonly ExternalAgentDescriptor[]>;
}

// ---------------------------------------------------------------------------
// System calls — injectable I/O boundary for testing
// ---------------------------------------------------------------------------

/** Thin wrapper over OS-level calls so PATH scanning is fully testable. */
export interface SystemCalls {
  /** Resolve a binary name to its absolute path, or null if not on PATH. */
  readonly which: (cmd: string) => string | null;
  /** Execute a command with args and a timeout; returns exit code + stdout. */
  readonly exec: (
    cmd: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

// ---------------------------------------------------------------------------
// Known CLI agent definition
// ---------------------------------------------------------------------------

/** Static definition of a well-known CLI coding agent. */
export interface KnownCliAgent {
  readonly name: string;
  readonly displayName: string;
  readonly binaries: readonly string[];
  readonly capabilities: readonly string[];
  readonly versionFlag: string;
  readonly transport: ExternalAgentTransport;
}

// ---------------------------------------------------------------------------
// MCP agent source — narrow dependency injection interface
// ---------------------------------------------------------------------------

/** Tool info returned by an MCP manager's listTools(). */
export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
}

/** Narrow interface for an MCP manager that can list tools. */
export interface McpAgentSource {
  readonly name: string;
  readonly listTools: () => Promise<Result<readonly McpToolInfo[]>>;
}

// ---------------------------------------------------------------------------
// Discovery options
// ---------------------------------------------------------------------------

/** Filter options for discovery results. */
export interface DiscoveryFilter {
  readonly capability?: string | undefined;
  readonly transport?: ExternalAgentTransport | undefined;
  readonly source?: ExternalAgentSource | undefined;
}

/** Configuration for the discovery provider. */
export interface DiscoveryProviderConfig {
  /** Known CLI agents to scan for on PATH. Defaults to KNOWN_CLI_AGENTS. */
  readonly knownAgents?: readonly KnownCliAgent[] | undefined;
  /** System calls implementation. Defaults to real Bun-based calls. */
  readonly systemCalls?: SystemCalls | undefined;
  /** Directory to scan for filesystem-registered agents. */
  readonly registryDir?: string | undefined;
  /** MCP managers to scan for agent-like tools. */
  readonly mcpSources?: readonly McpAgentSource[] | undefined;
  /** Cache TTL in milliseconds. Defaults to DEFAULT_CACHE_TTL_MS. */
  readonly cacheTtlMs?: number | undefined;
  /** Health check timeout in milliseconds. Defaults to DEFAULT_HEALTH_TIMEOUT_MS. */
  readonly healthTimeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Health check result
// ---------------------------------------------------------------------------

/** Result of a health check on an external agent. */
export interface HealthCheckResult {
  readonly status: "healthy" | "unhealthy" | "unknown";
  readonly latencyMs: number;
  readonly message?: string | undefined;
}
