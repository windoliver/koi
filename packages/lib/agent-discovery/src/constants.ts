import type { KnownCliAgent } from "./types.js";

export const DEFAULT_CACHE_TTL_MS = 60_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export const SOURCE_PRIORITY = {
  mcp: 0,
  filesystem: 1,
  path: 2,
} as const;

export const AGENT_KEYWORDS = [
  "agent",
  "assistant",
  "code",
  "chat",
  "generate",
  "review",
] as const;

export const KNOWN_CLI_AGENTS: readonly KnownCliAgent[] = [
  {
    name: "claude-code",
    displayName: "Claude Code",
    binaries: ["claude"],
    capabilities: ["code-generation", "code-review", "debugging", "refactoring"],
    versionFlag: "--version",
    transport: "cli",
  },
  {
    name: "codex",
    displayName: "OpenAI Codex CLI",
    binaries: ["codex"],
    capabilities: ["code-generation", "debugging"],
    versionFlag: "--version",
    transport: "cli",
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
  },
];
