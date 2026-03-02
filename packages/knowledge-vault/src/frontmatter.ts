/**
 * Hand-rolled YAML frontmatter parser.
 *
 * Handles flat key-value pairs, inline/multi-line tag lists, and common
 * value types (strings, numbers, booleans). Intentionally minimal —
 * no nested objects, no multi-line strings. Malformed frontmatter
 * yields empty metadata (no throw).
 */

/** Result of parsing a markdown file's frontmatter. */
export interface FrontmatterResult {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly body: string;
}

const FRONTMATTER_REGEX = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*\r?\n?/;
const INLINE_LIST_REGEX = /^\[([^\]]*)\]$/;
const HASH_PREFIX_REGEX = /^#\s*/;

/**
 * Parse YAML frontmatter from markdown content.
 *
 * Extracts `---`-delimited frontmatter block and parses flat key-value
 * pairs. Returns empty metadata if no frontmatter or if parsing fails.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  if (content === "") {
    return { metadata: {}, body: "" };
  }

  const match = FRONTMATTER_REGEX.exec(content);
  if (match === null) {
    return { metadata: {}, body: content };
  }

  const rawYaml = match[1] ?? "";
  const body = content.slice(match[0].length);
  const metadata = parseYamlBlock(rawYaml);

  return { metadata, body };
}

function parseYamlBlock(raw: string): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const lines = raw.split("\n");

  // let is required here — we track index for multi-line list parsing
  let i = 0; // mutable: iterating with lookahead for multi-line lists
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i += 1;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (key === "") {
      i += 1;
      continue;
    }

    // Check for multi-line list (value empty, next lines start with "- ")
    if (rawValue === "" && i + 1 < lines.length) {
      const nextLine = lines[i + 1] ?? "";
      if (/^\s+-\s/.test(nextLine)) {
        const items: string[] = [];
        i += 1;
        while (i < lines.length) {
          const listLine = lines[i] ?? "";
          const listMatch = /^\s+-\s+(.*)$/.exec(listLine);
          if (listMatch === null) break;
          const item = stripHashPrefix(parseScalarValue(listMatch[1]?.trim() ?? ""));
          items.push(typeof item === "string" ? item : String(item));
          i += 1;
        }
        result[key] = items;
        continue;
      }
    }

    // Inline list: [a, b, c]
    const inlineMatch = INLINE_LIST_REGEX.exec(rawValue);
    if (inlineMatch !== null) {
      const inner = inlineMatch[1] ?? "";
      const items = inner
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "")
        .map((s) => {
          const parsed = parseScalarValue(s);
          return typeof parsed === "string" ? stripHashPrefix(parsed) : String(parsed);
        });
      result[key] = items;
      i += 1;
      continue;
    }

    result[key] = parseScalarValue(rawValue);
    i += 1;
  }

  return result;
}

function parseScalarValue(raw: string): string | number | boolean {
  // Quoted strings
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Booleans
  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "yes") return true;
  if (lower === "false" || lower === "no") return false;

  // Numbers
  if (raw !== "" && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }

  return raw;
}

function stripHashPrefix(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(HASH_PREFIX_REGEX, "");
  }
  return value;
}
