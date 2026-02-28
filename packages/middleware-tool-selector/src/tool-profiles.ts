/**
 * Named tool profiles — declarative presets for common agent roles.
 *
 * Instead of writing a custom selectTools function, declare `profile: "coding"`
 * in the manifest and get a curated 4-10 tool set automatically.
 */

/**
 * Predefined tool profiles. Each maps a role name to a readonly list of tool
 * names. An empty list (like "full") means no filtering — all tools pass through.
 */
export const TOOL_PROFILES: {
  readonly minimal: readonly string[];
  readonly coding: readonly string[];
  readonly research: readonly string[];
  readonly automation: readonly string[];
  readonly conversation: readonly string[];
  readonly full: readonly string[];
} = {
  minimal: ["memory_store", "memory_recall", "file_read", "file_write"],
  coding: [
    "file_read",
    "file_write",
    "file_list",
    "file_delete",
    "shell_exec",
    "apply_patch",
    "search_forge",
  ],
  research: ["web_fetch", "web_search", "memory_store", "memory_recall", "file_write"],
  automation: ["shell_exec", "file_read", "file_write", "schedule_create", "browser_navigate"],
  conversation: ["memory_store", "memory_recall"],
  full: [],
} as const satisfies Record<string, readonly string[]>;

/** Valid profile name — one of the keys in TOOL_PROFILES. */
export type ToolProfileName = keyof typeof TOOL_PROFILES;

/** Type guard for ToolProfileName. */
export function isToolProfileName(value: unknown): value is ToolProfileName {
  return typeof value === "string" && value in TOOL_PROFILES;
}
