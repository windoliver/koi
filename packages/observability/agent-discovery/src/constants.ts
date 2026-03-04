/**
 * Constants for agent discovery — known agents, defaults, and source priority.
 */

import type { ExternalAgentSource } from "@koi/core";
import type { KnownCliAgent } from "./types.js";

/** Well-known CLI coding agents with their binary names and capabilities. */
export const KNOWN_CLI_AGENTS: readonly KnownCliAgent[] = [
  {
    name: "claude-code",
    displayName: "Claude Code",
    binaries: ["claude"],
    capabilities: ["code-generation", "code-review", "debugging", "refactoring"],
    versionFlag: "--version",
    transport: "cli",
    protocol: "acp",
  },
  {
    name: "codex",
    displayName: "OpenAI Codex CLI",
    binaries: ["codex"],
    capabilities: ["code-generation", "debugging"],
    versionFlag: "--version",
    transport: "cli",
    protocol: "acp",
  },
  {
    name: "aider",
    displayName: "Aider",
    binaries: ["aider"],
    capabilities: ["code-generation", "code-review", "refactoring"],
    versionFlag: "--version",
    transport: "cli",
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    binaries: ["opencode"],
    capabilities: ["code-generation", "debugging"],
    versionFlag: "--version",
    transport: "cli",
  },
  {
    name: "gemini-cli",
    displayName: "Gemini CLI",
    binaries: ["gemini"],
    capabilities: ["code-generation", "code-review"],
    versionFlag: "--version",
    transport: "cli",
    protocol: "acp",
  },
] as const;

/** Default cache TTL in milliseconds. */
export const DEFAULT_CACHE_TTL_MS = 60_000;

/** Default health check timeout in milliseconds. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Source priority for deduplication — lower number = higher priority.
 * MCP > filesystem > PATH.
 */
export const SOURCE_PRIORITY: Readonly<Record<ExternalAgentSource, number>> = {
  mcp: 0,
  filesystem: 1,
  path: 2,
} as const;
