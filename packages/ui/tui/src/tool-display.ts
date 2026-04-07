/**
 * Tool display mapper — converts raw tool name + args to structured display.
 *
 * Known tools get a human-readable title, a subtitle extracted from the most
 * important argument, and up to 3 scalar chips for secondary args.
 * Unknown/MCP tools fall back to a generic renderer using Object.entries.
 *
 * Design: static map + optional title(args) override for input-sensitive tools
 * (e.g., `fs_edit` → "Create" when old_string is empty, "Edit" otherwise).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolDisplay {
  readonly title: string;
  readonly subtitle: string;
  readonly chips: readonly string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Keys to check (in priority order) for the subtitle value. */
const SUBTITLE_KEYS = [
  "file_path",
  "filePath",
  "path",
  "url",
  "command",
  "pattern",
  "query",
  "name",
  "description",
] as const;

const MAX_CHIPS = 3;
const MAX_SUBTITLE_LENGTH = 80;

interface ToolDisplayEntry {
  /** Static title string, or a function for input-sensitive titles. */
  readonly title: string | ((args: Readonly<Record<string, unknown>>) => string);
  /** Override the default SUBTITLE_KEYS scan with a specific key. */
  readonly subtitleKey?: string | undefined;
}

/**
 * Known tool entries. Tool names use suffix matching (`_read`, `_write`, etc.)
 * so prefixed variants (`fs_read`, `nexus_read`, `local_fs_read`) all resolve.
 */
const TOOL_MAP: Readonly<Record<string, ToolDisplayEntry>> = {
  // Unprefixed built-ins
  Glob: { title: "Glob", subtitleKey: "pattern" },
  Grep: { title: "Search", subtitleKey: "pattern" },
  Bash: { title: "Shell", subtitleKey: "command" },
  ToolSearch: { title: "Tool Search", subtitleKey: "query" },
  Spawn: { title: "Spawn", subtitleKey: "name" },
};

/** Suffix-based entries for prefixed tools (`fs_read`, `web_fetch`, etc.). */
const SUFFIX_MAP: readonly (readonly [string, ToolDisplayEntry])[] = [
  ["_read", { title: "Read", subtitleKey: "file_path" }],
  [
    "_write",
    {
      title: (args) => (args.create === true ? "Create" : "Write"),
      subtitleKey: "file_path",
    },
  ],
  [
    "_edit",
    {
      title: (args) => {
        const old = args.old_string;
        return old === undefined || old === "" ? "Create" : "Edit";
      },
      subtitleKey: "file_path",
    },
  ],
  ["_fetch", { title: "Fetch", subtitleKey: "url" }],
  ["_search", { title: "Web Search", subtitleKey: "query" }],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEntry(toolName: string): ToolDisplayEntry | undefined {
  const exact = TOOL_MAP[toolName];
  if (exact !== undefined) return exact;

  for (const [suffix, entry] of SUFFIX_MAP) {
    if (toolName.endsWith(suffix)) return entry;
  }
  return undefined;
}

function resolveTitle(entry: ToolDisplayEntry, args: Readonly<Record<string, unknown>>): string {
  return typeof entry.title === "function" ? entry.title(args) : entry.title;
}

function extractSubtitle(
  args: Readonly<Record<string, unknown>>,
  subtitleKey: string | undefined,
): string {
  // If a specific key is configured, try it first
  if (subtitleKey !== undefined) {
    const value = args[subtitleKey];
    if (typeof value === "string" && value !== "") {
      return truncate(value);
    }
  }

  // Fall back to scanning SUBTITLE_KEYS in priority order
  for (const key of SUBTITLE_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value !== "") {
      return truncate(value);
    }
  }
  return "";
}

function extractChips(
  args: Readonly<Record<string, unknown>>,
  subtitleKey: string | undefined,
): readonly string[] {
  // Keys already consumed by subtitle extraction — exclude from chips
  const consumed = new Set<string>(SUBTITLE_KEYS);
  if (subtitleKey !== undefined) consumed.add(subtitleKey);

  const chips: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (chips.length >= MAX_CHIPS) break;
    if (consumed.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      chips.push(`${key}=${String(value)}`);
    }
  }
  return chips;
}

function truncate(text: string): string {
  if (text.length <= MAX_SUBTITLE_LENGTH) return text;
  return `${text.slice(0, MAX_SUBTITLE_LENGTH - 1)}…`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a raw tool name and parsed args to a structured display.
 *
 * Returns `{ title, subtitle, chips }` for rendering in the TUI.
 * Unknown tools use the raw tool name as title and fall back to
 * generic subtitle/chip extraction from args.
 */
export function getToolDisplay(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): ToolDisplay {
  const entry = findEntry(toolName);
  if (entry !== undefined) {
    return {
      title: resolveTitle(entry, args),
      subtitle: extractSubtitle(args, entry.subtitleKey),
      chips: extractChips(args, entry.subtitleKey),
    };
  }

  // Generic fallback for MCP / unknown tools
  return {
    title: toolName,
    subtitle: extractSubtitle(args, undefined),
    chips: extractChips(args, undefined),
  };
}
