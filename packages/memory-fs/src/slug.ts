/**
 * Sanitize entity names into safe filesystem slugs.
 *
 * - Lowercase
 * - Non-alphanumeric (except `-`) replaced with `-`
 * - Collapse consecutive dashes, trim leading/trailing dashes
 * - Limit to 64 chars
 * - Path traversal guard (`..`, absolute paths)
 * - Empty → `"_default"`
 */
export function slugifyEntity(name: string): string {
  if (name.length === 0) return "_default";

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  // Guard against path traversal or empty result after sanitization
  if (slug.length === 0 || slug === "." || slug === "..") return "_default";

  return slug;
}
