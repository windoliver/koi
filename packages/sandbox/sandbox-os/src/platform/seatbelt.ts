import type { SandboxProfile } from "@koi/core";

import { stripGlobSuffix } from "../path-utils.js";

/**
 * macOS uses top-level symlinks that seatbelt does NOT resolve:
 *   /var  → /private/var
 *   /tmp  → /private/tmp
 *   /etc  → /private/etc
 *
 * Seatbelt matches rule paths literally, so `(subpath "/tmp/foo")` will NOT
 * match `/private/tmp/foo` — the actual path seen by the kernel. Canonicalize
 * all paths before writing rules to the profile.
 */
const MACOS_SYMLINK_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["/var", "/private/var"],
  ["/tmp", "/private/tmp"],
  ["/etc", "/private/etc"],
] as const;

function canonicalizeMacOsPath(path: string): string {
  for (const [from, to] of MACOS_SYMLINK_PREFIXES) {
    if (path === from || path.startsWith(`${from}/`)) {
      return to + path.slice(from.length);
    }
  }
  return path;
}

/**
 * Resolve a path for use in a seatbelt rule.
 * - ~/... → {home}/...  (home must be passed explicitly)
 * - Glob patterns (path/*) → base directory (path/)
 * - Relative paths are rejected (return null)
 * - Absolute paths are canonicalized (/tmp → /private/tmp etc.)
 */
function resolvePath(path: string, home: string | undefined): string | null {
  let resolved = path;

  if (resolved.startsWith("~/")) {
    if (home === undefined) return null;
    resolved = `${home}${resolved.slice(1)}`;
  } else if (resolved.startsWith("~")) {
    // bare ~user — not supported
    return null;
  } else if (!resolved.startsWith("/")) {
    // relative paths rejected per validation contract
    return null;
  }

  // Strip glob suffix — use the base directory as a subpath rule
  resolved = stripGlobSuffix(resolved);

  return canonicalizeMacOsPath(resolved);
}

function escapeSeatbeltPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Generate a macOS Seatbelt (.sb) profile string from a SandboxProfile.
 *
 * Strategy (required by macOS dyld/frameworks):
 *   - deny-default overall
 *   - allow process execution, sysctl, mach IPC, signals
 *   - broad file-read-data + file-read-metadata (dyld needs this)
 *   - denyRead entries overlay specific subtrees
 *   - deny all writes, then allow specific write paths
 *   - network: binary allow/deny
 *
 * IMPORTANT — operation naming: seatbelt does NOT support `file-read*` as a
 * wildcard operation name in deny rules. The `*` is treated literally and matches
 * no actual operation, so `(deny file-read* (subpath ...))` has no effect.
 * Use explicit `file-read-data` and `file-read-metadata` instead.
 *
 * Specificity: rules with a path predicate (subpath/literal) are more specific
 * than rules without one. More specific rules take precedence regardless of order,
 * so denyRead entries correctly override the broad `(allow file-read-data)` above.
 *
 * @param opts.home - HOME directory for ~/... path expansion.
 *   Defaults to process.env.HOME. Pass explicitly in tests or sandboxed contexts
 *   where process.env.HOME may not reflect the intended user home directory.
 */
export function generateSeatbeltProfile(
  profile: SandboxProfile,
  opts?: { readonly home?: string },
): string {
  const home = opts?.home ?? process.env.HOME;

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    // Process execution — required to spawn the target command
    "(allow process*)",
    "(allow sysctl*)",
    "(allow mach*)",
    "(allow signal)",
    // Broad file reads — macOS dyld, system frameworks, and shared libraries
    // require read access to paths that cannot be enumerated at profile time.
    // denyRead entries below shadow this for sensitive subtrees (path-predicate
    // rules are more specific and take precedence over this broad allow).
    "(allow file-read-data)",
    "(allow file-read-metadata)",
  ];

  // Block sensitive read paths. Uses explicit `file-read-data` and
  // `file-read-metadata` — NOT `file-read*` (wildcard is not valid in seatbelt
  // operation names and silently matches nothing).
  for (const path of profile.filesystem.denyRead ?? []) {
    const resolved = resolvePath(path, home);
    if (resolved !== null) {
      const escaped = escapeSeatbeltPath(resolved);
      lines.push(`(deny file-read-data (subpath "${escaped}"))`);
      lines.push(`(deny file-read-metadata (subpath "${escaped}"))`);
    }
  }

  // Deny all writes by default, then open specific paths
  lines.push("(deny file-write*)");
  lines.push('(allow file-write* (literal "/dev/null"))');

  for (const path of profile.filesystem.allowWrite ?? []) {
    const resolved = resolvePath(path, home);
    if (resolved !== null) {
      lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(resolved)}"))`);
    }
  }

  // denyWrite: in seatbelt, deny rules take precedence over allow rules,
  // so adding deny after allow correctly revokes write access to subtrees.
  for (const path of profile.filesystem.denyWrite ?? []) {
    const resolved = resolvePath(path, home);
    if (resolved !== null) {
      lines.push(`(deny file-write* (subpath "${escapeSeatbeltPath(resolved)}"))`);
    }
  }

  // Network: binary on/off — per-host filtering requires the proxy layer
  lines.push(profile.network.allow ? "(allow network*)" : "(deny network*)");

  return `${lines.join("\n")}\n`;
}

export function buildSeatbeltPrefix(profileStr: string): readonly string[] {
  // Passes profile inline via -p. For very large profiles (many hundreds of paths),
  // consider writing to a temp file and using -f instead — avoids ARG_MAX limits
  // and hides sensitive deny-list paths from process argument listings.
  return ["sandbox-exec", "-p", profileStr];
}
