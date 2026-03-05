/**
 * External agent descriptor — types for runtime discovery of coding agents
 * (Claude Code, Codex, OpenCode, Aider, Gemini) on the host machine.
 *
 * L0 types only — no runtime code.
 */

/** Transport protocol used to communicate with the external agent. */
export type ExternalAgentTransport = "cli" | "mcp" | "a2a";

/** Wire protocol for sandboxed agent communication. */
export type ExternalAgentProtocol = "acp" | "stdio";

/** Discovery source that found the external agent. */
export type ExternalAgentSource = "path" | "mcp" | "filesystem" | "manifest";

/** Descriptor for an external coding agent discovered at runtime. */
export interface ExternalAgentDescriptor {
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly transport: ExternalAgentTransport;
  /** Executable command for CLI transport (e.g., "claude", "aider"). */
  readonly command?: string | undefined;
  readonly capabilities: readonly string[];
  /** Health status: true = healthy, false = unhealthy, undefined = not checked. */
  readonly healthy?: boolean | undefined;
  readonly source: ExternalAgentSource;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Wire protocol for sandboxed spawning: "acp" for JSON-RPC, "stdio" for raw stdin/stdout. */
  readonly protocol?: ExternalAgentProtocol | undefined;
}
