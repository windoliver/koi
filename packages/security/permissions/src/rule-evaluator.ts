/**
 * Rule evaluator — glob + action matching with first-match-wins semantics.
 */

import type { PermissionDecision, PermissionQuery } from "@koi/core";

import type { CompiledRule } from "./rule-types.js";

/**
 * Test whether a resource path matches a compiled glob regex.
 */
function matchResource(compiled: RegExp, resource: string): boolean {
  return compiled.test(resource);
}

/**
 * Convert a glob pattern string to a RegExp.
 *
 * Supports:
 * - `*`  matches any single path segment (no `/`)
 * - `**` matches zero or more path segments (including `/`)
 * - Literal characters match exactly
 *
 * Throws `SyntaxError` if the resulting regex is invalid.
 */
export function compileGlob(pattern: string): RegExp {
  let result = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern.charAt(i);

    if (char === "*" && pattern.charAt(i + 1) === "*") {
      i += 2;
      if (pattern.charAt(i) === "/") {
        // `**/` — match zero or more path segments followed by separator
        result += "(?:.*/)?";
        i += 1;
      } else {
        // `**` at end — match zero or more path segments (including the directory itself).
        // If preceded by `/`, consume it to avoid double-slash in the regex.
        if (result.endsWith("/")) {
          result = result.slice(0, -1);
          result += "(?:/.*)?";
        } else {
          result += ".*";
        }
      }
    } else if (char === "*") {
      result += "[^/]*";
      i += 1;
    } else {
      // All non-glob characters (including ?, [, ]) are escaped as literals.
      result += escapeRegex(char);
      i += 1;
    }
  }

  result += "$";
  return new RegExp(result);
}

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchAction(ruleAction: string, queryAction: string): boolean {
  return ruleAction === "*" || ruleAction === queryAction;
}

function matchPrincipal(compiledPrincipal: RegExp | undefined, principal: string): boolean {
  if (compiledPrincipal === undefined) {
    return true;
  }
  return compiledPrincipal.test(principal);
}

function matchContext(
  compiledContext: Readonly<Record<string, RegExp>> | undefined,
  queryContext: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (compiledContext === undefined) {
    return true;
  }
  if (queryContext === undefined) {
    return false;
  }
  for (const key of Object.keys(compiledContext)) {
    const pattern = compiledContext[key];
    const value = queryContext[key];
    if (pattern === undefined || typeof value !== "string" || !pattern.test(value)) {
      return false;
    }
  }
  return true;
}

/**
 * Check whether a resource looks like a filesystem path (vs URL, namespace, etc.).
 * Filesystem paths start with `/`, `./`, `../`, or a bare segment followed by `/`.
 * URLs (containing `://`) and non-slash resources are NOT filesystem paths.
 */
function isFilesystemPath(resource: string): boolean {
  // URLs: scheme://... — not a filesystem path
  if (resource.includes("://")) {
    return false;
  }
  // Namespaced identifiers: prefix:value (e.g., agent:foo, tool:bar)
  // These are not filesystem paths even if the value contains slashes.
  // Exception: single-letter prefix followed by :/ is a Windows drive (C:/).
  const colonIndex = resource.indexOf(":");
  const slashIndex = resource.indexOf("/");
  const isWindowsDrive = colonIndex === 1 && /^[A-Za-z]$/.test(resource.charAt(0));
  if (colonIndex !== -1 && !isWindowsDrive && (slashIndex === -1 || colonIndex < slashIndex)) {
    return false;
  }
  // Bare dot segments are filesystem traversal attempts
  if (resource === "." || resource === "..") {
    return true;
  }
  // Must contain at least one path separator to be path-like
  return resource.includes("/") || resource.includes("\\");
}

/**
 * Normalize a filesystem resource string to prevent path traversal bypasses.
 *
 * - Collapses `//` to `/`
 * - Resolves `.` and `..` segments
 * - Preserves leading `/` for absolute paths
 * - For absolute paths, `..` at the root is clamped (cannot escape `/`)
 * - For relative paths, `..` that escapes above the starting point returns `null`
 *   (unresolvable without a known cwd — must be denied)
 *
 * Non-filesystem resources (URLs, namespaces like `agent:foo`) pass through unchanged.
 */
export function normalizeResource(resource: string): string | null {
  // Only normalize filesystem paths — URLs and non-path resources pass through verbatim
  if (!isFilesystemPath(resource)) {
    return resource;
  }

  // Normalize backslashes to forward slashes for platform-agnostic matching
  const normalized = resource.replaceAll("\\", "/");

  // Detect absolute roots: Unix `/...` or Windows drive `C:/...`
  const isUnixAbsolute = normalized.startsWith("/");
  const driveMatch = /^[A-Za-z]:\//.exec(normalized);
  const isAbsolute = isUnixAbsolute || driveMatch !== null;

  // For drive-letter paths, preserve the drive prefix (e.g., "C:")
  const drivePrefix = driveMatch !== null ? normalized.slice(0, 2) : undefined;
  const pathPart = drivePrefix !== undefined ? normalized.slice(2) : normalized;

  const segments = pathPart.split("/");
  const resolved: string[] = [];

  for (const seg of segments) {
    if (seg === "." || seg === "") {
      continue;
    }
    if (seg === "..") {
      if (resolved.length === 0) {
        if (!isAbsolute) {
          return null;
        }
        continue;
      }
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }

  const result = resolved.join("/");
  if (drivePrefix !== undefined) {
    return `${drivePrefix}/${result}`;
  }
  return isUnixAbsolute ? `/${result}` : result;
}

/** Regex matching `.` or `..` as a path segment within a resource value. */
const TRAVERSAL_SEGMENT = /(?:^|[/\\])\.\.?(?:[/\\]|$)/;

/**
 * Check if a namespace resource value contains path-traversal segments.
 * Namespace identifiers (agent:foo, tool:bar) should not contain
 * `.` or `..` segments — these have no legitimate meaning and could
 * be used to escape glob-based tenant scoping.
 */
function hasNamespaceTraversal(resource: string): boolean {
  const colonIndex = resource.indexOf(":");
  if (colonIndex === -1) {
    return false;
  }
  const value = resource.slice(colonIndex + 1);
  return TRAVERSAL_SEGMENT.test(value);
}

/**
 * Evaluate pre-compiled rules against a query. First matching rule wins.
 *
 * Resources are normalized before matching to prevent path traversal bypasses.
 * Namespace resources with traversal segments are denied.
 * Returns `{ effect: "ask" }` when no rule matches.
 */
export function evaluateRules(
  query: PermissionQuery,
  rules: readonly CompiledRule[],
): PermissionDecision {
  const resource = normalizeResource(query.resource);

  // Unresolvable relative paths (leading ..) are denied.
  if (resource === null) {
    return {
      effect: "deny",
      reason: "Resource path contains unresolvable traversal segments",
    };
  }

  // Namespace resources with traversal segments are denied.
  if (hasNamespaceTraversal(resource)) {
    return {
      effect: "deny",
      reason: "Namespace resource contains path traversal segments",
    };
  }

  for (const rule of rules) {
    if (
      matchPrincipal(rule.compiledPrincipal, query.principal) &&
      matchContext(rule.compiledContext, query.context) &&
      matchAction(rule.action, query.action) &&
      matchResource(rule.compiled, resource)
    ) {
      if (rule.effect === "allow") {
        return { effect: "allow" };
      }
      const reason = rule.reason ?? `Matched ${rule.source} rule: ${rule.pattern}`;
      return { effect: rule.effect, reason };
    }
  }

  return { effect: "ask", reason: "No matching permission rule" };
}
