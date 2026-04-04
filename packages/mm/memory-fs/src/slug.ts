/**
 * Derive safe filesystem filenames from memory record names.
 *
 * - Lowercase
 * - Non-alphanumeric (except `-`) replaced with `_`
 * - Collapse consecutive underscores
 * - Trim leading/trailing underscores
 * - Limit to 64 chars
 * - Path traversal guard
 * - Empty → `_memory`
 */
export function slugifyMemoryName(name: string): string {
  if (name.trim().length === 0) return "_memory";

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

  if (slug.length === 0 || slug === "." || slug === "..") return "_memory";

  return slug;
}

/**
 * Derive a `.md` filename from a memory name, resolving collisions
 * by appending a numeric suffix.
 */
export function deriveFilename(name: string, existingFiles: ReadonlySet<string>): string {
  const base = slugifyMemoryName(name);
  const candidate = `${base}.md`;
  if (!existingFiles.has(candidate)) return candidate;

  for (let i = 2; i <= 999; i++) {
    const suffixed = `${base}-${String(i)}.md`;
    if (!existingFiles.has(suffixed)) return suffixed;
  }

  // Extremely unlikely — 998 collisions on the same slug
  return `${base}-${Date.now()}.md`;
}
