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

export interface ResultDisplay {
  /** Scalar metadata chips extracted from the result (e.g., "exitCode=0"). */
  readonly chips: readonly string[];
  /** Main content body to render (stdout, file content, paths, etc.). */
  readonly body: string;
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

// ---------------------------------------------------------------------------
// Result display — Phase 3
// ---------------------------------------------------------------------------

/**
 * Keys that carry the main content body per tool result shape.
 * Checked in priority order; first match becomes the body.
 */
const BODY_KEYS = ["stdout", "content", "result", "body", "paths"] as const;

/**
 * Keys to extract as result chips (scalar metadata).
 * Order determines chip display order.
 */
const RESULT_CHIP_KEYS = [
  "exitCode",
  "status",
  "contentType",
  "durationMs",
  "bytesWritten",
  "modified",
  "truncated",
  "timedOut",
  "total",
  "mode",
  "format",
  "code",
] as const;

/** Keys that are content bodies or metadata — never shown as generic chips. */
const RESULT_CONSUMED_KEYS = new Set<string>([
  ...BODY_KEYS,
  ...RESULT_CHIP_KEYS,
  // Large string fields that should not appear as chips
  "stderr",
  "error",
  "statusText",
  "finalUrl",
  "truncatedNote",
  "warnings",
  "category",
  "reason",
  "pattern",
  "path",
  // AccumulatedToolCall fields — the engine emits tool_call_end with the
  // accumulated call metadata, not the tool's execution output. These fields
  // duplicate the title/subtitle/chips from args display and must be hidden.
  "toolName",
  "callId",
  "rawArgs",
  "parsedArgs",
  "parseError",
]);

function extractResultChips(obj: Readonly<Record<string, unknown>>): readonly string[] {
  const chips: string[] = [];
  for (const key of RESULT_CHIP_KEYS) {
    if (chips.length >= MAX_CHIPS) break;
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      chips.push(`${key}=${String(value)}`);
    }
  }
  return chips;
}

function extractResultBody(obj: Readonly<Record<string, unknown>>): string {
  // Check for error shape first
  const error = obj.error;
  if (typeof error === "string" && error !== "") return error;

  // Check body keys in priority order
  for (const key of BODY_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value !== "") return value;
    if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join("\n");
  }

  // Fallback: collect remaining scalar values
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (RESULT_CONSUMED_KEYS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.join("\n");
}

/**
 * Extract structured result display from a tool result string.
 *
 * Results are stored as JSON-stringified strings by the reducer's capResult().
 * This function parses them back and extracts scalar metadata chips (exitCode,
 * status, bytesWritten, etc.) and a main content body (stdout, content, paths).
 *
 * Falls back to raw result string when parsing fails or result is not an object.
 */
export function getResultDisplay(result: string): ResultDisplay {
  if (result === "" || result === "[unserializable]") {
    return { chips: [], body: result };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    // Not JSON — plain string result (e.g., pre-formatted text)
    return { chips: [], body: result };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { chips: [], body: result };
  }

  const obj = parsed as Readonly<Record<string, unknown>>;
  return {
    chips: extractResultChips(obj),
    body: extractResultBody(obj),
  };
}
