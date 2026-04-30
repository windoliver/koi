import type { ExternalAgentDescriptor, ExternalAgentTransport } from "@koi/core";

export interface SystemCalls {
  readonly which: (binary: string) => Promise<string | null>;
  readonly readDir: (path: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<string>;
  readonly spawn: (
    cmd: readonly string[],
    timeoutMs: number,
  ) => Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

export interface KnownCliAgent {
  readonly name: string;
  readonly displayName?: string;
  readonly binaries: readonly string[];
  readonly capabilities: readonly string[];
  readonly versionFlag?: string;
  readonly transport: ExternalAgentTransport;
}

export interface McpAgentSource {
  readonly name: string;
  /**
   * REQUIRED for the server to be surfaced as an external agent. Servers must
   * explicitly declare themselves as agents — keyword matches on tool names
   * alone are not sufficient (a generic "code_search" tool does not make the
   * server an agent). When false/undefined, the server is ignored entirely.
   */
  readonly isAgent: boolean;
  /**
   * Capabilities advertised by the server. When provided, used verbatim on
   * the resulting descriptor. When omitted, defaults to ["code-generation"]
   * for backwards compatibility with existing coding-agent integrations.
   */
  readonly capabilities?: readonly string[];
  readonly listTools: () => Promise<
    | {
        readonly ok: true;
        readonly value: readonly { readonly name: string; readonly description?: string }[];
      }
    | { readonly ok: false; readonly error: { readonly message: string } }
  >;
}

export interface DiscoveryFilter {
  readonly capability?: string;
  readonly transport?: ExternalAgentTransport;
  readonly source?: "path" | "mcp" | "filesystem";
}

export interface DiscoverySource {
  readonly id: "path" | "mcp" | "filesystem";
  readonly priority: number;
  readonly discover: () => Promise<readonly ExternalAgentDescriptor[]>;
}

export interface DiscoveryProviderConfig {
  readonly knownAgents?: readonly KnownCliAgent[];
  readonly systemCalls?: SystemCalls;
  readonly registryDir?: string;
  readonly mcpSources?: readonly McpAgentSource[];
  readonly cacheTtlMs?: number;
  readonly healthTimeoutMs?: number;
}

export interface DiscoveryHandle {
  readonly discover: (opts?: {
    readonly filter?: DiscoveryFilter;
  }) => Promise<readonly ExternalAgentDescriptor[]>;
  readonly invalidate: () => void;
}
