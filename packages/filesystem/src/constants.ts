/**
 * Constants for @koi/filesystem — tool names and SDK mappings.
 */

/** Default tool name prefix for filesystem tools. */
export const DEFAULT_PREFIX = "fs" as const;

/** All filesystem operation names. */
export const OPERATIONS = ["read", "write", "edit", "list", "search"] as const;

export type FileSystemOperation = (typeof OPERATIONS)[number];

/**
 * Built-in Claude SDK tools to block when using Koi filesystem.
 * Pass to `ClaudeAdapterConfig.disallowedTools` to prevent the SDK
 * from exposing its own file tools alongside the Koi ones.
 */
export const CLAUDE_SDK_FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"] as const;
