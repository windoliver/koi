type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (!isRecord(value)) {
    return JSON.stringify(value);
  }
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function normalizePackageJsonForDocs(parsed: unknown): JsonValue {
  if (!isRecord(parsed)) return parsed as JsonValue;
  const normalized: Record<string, unknown> = { ...parsed };
  delete normalized.scripts;
  return normalized as JsonValue;
}

/** Returns true when package.json changes can affect package/API/wiring docs. */
export function packageJsonChangeRequiresDocUpdate(
  beforeContent: string,
  afterContent: string,
): boolean {
  const before = normalizePackageJsonForDocs(JSON.parse(beforeContent));
  const after = normalizePackageJsonForDocs(JSON.parse(afterContent));
  return stableJson(before) !== stableJson(after);
}
