import type { SandboxProfile } from "@koi/core";

/**
 * Resolve a path for use in a seatbelt rule.
 * - ~/... → $HOME/...
 * - Glob patterns (path/*) → base directory (path/)
 * - Relative paths are rejected (return null)
 * - Absolute paths returned as-is
 */
function resolvePath(path: string): string | null {
  let resolved = path;

  if (resolved.startsWith("~/")) {
    const home = process.env["HOME"];
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
  return resolved.replace(/\/?\*.*$/, "");
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
 */
export function generateSeatbeltProfile(profile: SandboxProfile): string {
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
    const resolved = resolvePath(path);
    if (resolved !== null) {
      lines.push(`(deny file-read* (subpath "${escapeSeatbeltPath(resolved)}"))`);
    }
  }

  // Deny all writes by default, then open specific paths
  lines.push("(deny file-write*)");
  lines.push('(allow file-write* (literal "/dev/null"))');

  for (const path of profile.filesystem.allowWrite ?? []) {
    const resolved = resolvePath(path);
    if (resolved !== null) {
      lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(resolved)}"))`);
    }
  }

  // denyWrite: in seatbelt, deny rules take precedence over allow rules,
  // so adding deny after allow correctly revokes write access to subtrees.
  for (const path of profile.filesystem.denyWrite ?? []) {
    const resolved = resolvePath(path);
    if (resolved !== null) {
      lines.push(`(deny file-write* (subpath "${escapeSeatbeltPath(resolved)}"))`);
    }
  }

  // Network: binary on/off — per-host filtering requires the proxy layer
  lines.push(profile.network.allow ? "(allow network*)" : "(deny network*)");

  return `${lines.join("\n")}\n`;
}

export function buildSeatbeltPrefix(profileStr: string): readonly string[] {
  return ["sandbox-exec", "-p", profileStr];
}
