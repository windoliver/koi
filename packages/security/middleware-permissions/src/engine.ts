/**
 * Pattern-based permission backend and approval handler.
 */

import type { JsonObject } from "@koi/core/common";
import type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";

export interface PermissionRules {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
}

/**
 * Built-in tool group presets matching common agent tool categories.
 * Use with `group:<name>` in permission rules, e.g. `allow: ["group:fs_read"]`.
 *
 * Groups use prefix wildcards so they match any tool within the category.
 * Consumers can override or extend these by merging with their own groups map.
 */
export const DEFAULT_GROUPS: Readonly<Record<string, readonly string[]>> = {
  /** Filesystem — read + write + delete */
  fs: ["fs:*", "fs_*"],
  /** Filesystem read-only subset */
  fs_read: [
    "fs:read",
    "fs:stat",
    "fs:list",
    "fs:glob",
    "fs_read",
    "fs_stat",
    "fs_list",
    "fs_search",
  ],
  /** Filesystem write subset */
  fs_write: ["fs:write", "fs:create", "fs:mkdir", "fs_write", "fs_create", "fs_edit", "fs_mkdir"],
  /** Filesystem destructive subset */
  fs_delete: ["fs:delete", "fs:rm", "fs:rmdir", "fs_delete", "fs_rm", "fs_rmdir"],
  /** Shell / process execution */
  runtime: ["exec", "spawn", "bash", "shell"],
  /** HTTP / network calls */
  web: ["http:*", "fetch", "curl"],
  /** Browser automation (Playwright-style) */
  browser: ["browser_*"],
  /** Database operations */
  db: ["db:*"],
  /** Database read-only subset */
  db_read: ["db:query", "db:read", "db:select"],
  /** Database write subset */
  db_write: ["db:write", "db:insert", "db:update", "db:delete"],
  /** Language server protocol tools */
  lsp: ["lsp/*"],
  /** MCP server tools (all servers) */
  mcp: ["mcp/*"],
} as const;

export interface PatternBackendConfig {
  readonly rules: PermissionRules;
  readonly defaultDeny?: boolean;
  readonly groups?: Readonly<Record<string, readonly string[]>>;
}

export interface ApprovalHandler {
  readonly requestApproval: (
    toolId: string,
    input: JsonObject,
    reason: string,
    agentId?: string,
  ) => Promise<boolean>;
}

/**
 * Matches a tool ID against a glob-like pattern.
 * Supports:
 * - Exact match: "my-tool"
 * - Wildcard: "*" (matches everything)
 * - Prefix wildcard: "fs:*" (matches "fs:read", "fs:write", etc.)
 */
function matchesPattern(toolId: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return toolId.startsWith(prefix);
  }
  return toolId === pattern;
}

function matchesAny(toolId: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(toolId, p));
}

/**
 * Expands `group:<name>` references in patterns using the provided group map.
 * Unknown groups are preserved as literal patterns.
 */
function expandGroups(
  patterns: readonly string[],
  groups: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  return patterns.flatMap((p) => {
    if (!p.startsWith("group:")) return [p];
    const name = p.slice(6);
    return groups[name] ?? [p];
  });
}

/**
 * Pattern-based permission backend.
 * Evaluation order: deny-first, then ask, then allow, then defaultDeny.
 */
export function createPatternPermissionBackend(config: PatternBackendConfig): PermissionBackend {
  const defaultDeny = config.defaultDeny ?? true;
  const groups = config.groups ?? {};

  // Pre-expand groups at construction time (not per-check)
  const deny = expandGroups(config.rules.deny, groups);
  const ask = expandGroups(config.rules.ask, groups);
  const allow = expandGroups(config.rules.allow, groups);

  return {
    check(query: PermissionQuery): PermissionDecision {
      if (matchesAny(query.resource, deny)) {
        return { effect: "deny", reason: `Tool "${query.resource}" is denied by policy` };
      }
      if (matchesAny(query.resource, ask)) {
        return { effect: "ask", reason: `Tool "${query.resource}" requires approval` };
      }
      if (matchesAny(query.resource, allow)) {
        return { effect: "allow" };
      }
      return defaultDeny
        ? { effect: "deny", reason: `Tool "${query.resource}" not in allow list (default deny)` }
        : { effect: "allow" };
    },
  };
}

/**
 * Auto-approval handler for testing and development.
 * Always approves all requests.
 */
export function createAutoApprovalHandler(): ApprovalHandler {
  return {
    requestApproval: async (
      _toolId: string,
      _input: JsonObject,
      _reason: string,
    ): Promise<boolean> => true,
  };
}
