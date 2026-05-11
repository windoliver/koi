import type { PermissionQuery } from "@koi/core";
import type { ApprovalZone, ZoneMatch } from "./zone-types.js";

/**
 * Convert a glob pattern to RegExp.
 * `*`  → single path segment (no `/`); `**` → zero or more segments.
 * Local copy of the dialect used by @koi/permissions; do not import that
 * package (L2→L2 violation).
 */
function compileGlob(pattern: string): RegExp {
  let result = "^";
  for (let i = 0; i < pattern.length; ) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern.charAt(i + 1) === "*") {
      i += 2;
      if (pattern.charAt(i) === "/") {
        result += "(?:.*/)?";
        i += 1;
      } else if (result.endsWith("/")) {
        result = `${result.slice(0, -1)}(?:/.*)?`;
      } else {
        result += ".*";
      }
    } else if (c === "*") {
      result += "[^/]*";
      i += 1;
    } else {
      result += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`${result}$`);
}

const compiledCache = new WeakMap<readonly string[], readonly RegExp[]>();

function compileAll(patterns: readonly string[]): readonly RegExp[] {
  let cached = compiledCache.get(patterns);
  if (cached === undefined) {
    cached = patterns.map(compileGlob);
    compiledCache.set(patterns, cached);
  }
  return cached;
}

function anyMatch(patterns: readonly string[], value: string): boolean {
  for (const re of compileAll(patterns)) {
    if (re.test(value)) return true;
  }
  return false;
}

function matchesArgs(
  predicate: Readonly<Record<string, string>>,
  context: PermissionQuery["context"],
): boolean {
  if (context === undefined) return false;
  for (const [key, pattern] of Object.entries(predicate)) {
    const value = context[key];
    if (typeof value !== "string") return false;
    if (!compileGlob(pattern).test(value)) return false;
  }
  return true;
}

export function matchesZone(query: PermissionQuery, zone: ApprovalZone): boolean {
  const m: ZoneMatch = zone.match;
  if (m.tools !== undefined && !anyMatch(m.tools, query.action)) return false;
  if (m.paths !== undefined && !anyMatch(m.paths, query.resource)) return false;
  if (m.args !== undefined && !matchesArgs(m.args, query.context)) return false;
  return true;
}
