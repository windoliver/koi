import type { SandboxProfile } from "@koi/core";

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
  resolved = resolved.replace(/\/?\*.*$/, "");

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
    // We use a deny-list to block sensitive subtrees instead.
    "(allow file-read-data)",
    "(allow file-read-metadata)",
  ];

  // Block sensitive read paths (applied after the broad allow above)
  for (const path of profile.filesystem.denyRead ?? []) {
    const resolved = resolvePath(path, home);
    if (resolved !== null) {
      lines.push(`(deny file-read* (subpath "${escapeSeatbeltPath(resolved)}"))`);
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
