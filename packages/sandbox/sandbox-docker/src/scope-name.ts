import { createHash } from "node:crypto";

/**
 * Derive a deterministic, daemon-safe Docker container name from a persistence
 * scope key. The same scope always yields the same name so two adapter
 * instances racing `findOrCreate(scope)` will both attempt to create a
 * container with the same name; Docker rejects the loser with a name conflict.
 * The adapter then re-queries and reattaches to the winner instead of forking
 * a second sandbox for the same logical scope.
 *
 * Container name constraints (`/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,253}$/`):
 *   - leading char must be alphanumeric;
 *   - body may contain alphanumerics, `_`, `.`, `-`;
 *   - up to 255 chars total.
 *
 * Strategy: prefix with a fixed `koi-sb-` namespace, append a sanitized slice
 * of the scope (preserves human readability in `docker ps`), and suffix with
 * a short hash of the original scope so collisions across distinct-but-
 * sanitize-equivalent scopes stay distinct.
 */
export function deriveScopeContainerName(scope: string): string {
  const slug = scope
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  // Empty slug (scope was all special chars) — fall back to "x" so the prefix
  // produces a valid leading-alphanumeric name.
  const safeSlug = slug.length > 0 ? slug : "x";
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 12);
  return `koi-sb-${safeSlug}-${hash}`;
}
