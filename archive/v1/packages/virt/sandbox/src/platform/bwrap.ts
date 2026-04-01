/**
 * Linux bubblewrap (bwrap) argument construction.
 * Pure functions — no side effects.
 */

import type { SandboxProfile } from "../types.js";

/**
 * Build the full command-line args for bubblewrap.
 * Returns an immutable array of arguments.
 */
export function buildBwrapArgs(
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
): readonly string[] {
  const result: string[] = ["bwrap"];

  // Namespace isolation
  result.push("--unshare-all");

  // Network isolation
  // Note: bwrap only supports binary --unshare-net. allowedHosts is not
  // enforced because bwrap has no host filtering and iptables in a namespace
  // requires root. Use Docker adapter for host filtering.
  if (!profile.network.allow) {
    result.push("--unshare-net");
  }

  // Security hardening
  result.push("--new-session");
  result.push("--die-with-parent");

  // Standard system mounts (read-only)
  result.push("--ro-bind", "/usr", "/usr");
  result.push("--ro-bind", "/etc", "/etc");
  result.push("--symlink", "/usr/lib", "/lib");
  result.push("--symlink", "/usr/lib64", "/lib64");
  result.push("--symlink", "/usr/bin", "/bin");
  result.push("--symlink", "/usr/sbin", "/sbin");

  // Virtual filesystems
  result.push("--proc", "/proc");
  result.push("--dev", "/dev");
  result.push("--tmpfs", "/tmp");

  // Filesystem read mounts
  const fs = profile.filesystem;
  if (fs.allowRead !== undefined) {
    for (const path of fs.allowRead) {
      // Skip system paths we already mounted
      if (isSystemPath(path)) continue;
      result.push("--ro-bind", path, path);
    }
  }

  // Filesystem write mounts
  if (fs.allowWrite !== undefined) {
    for (const path of fs.allowWrite) {
      // Handle glob-like patterns by using the base directory
      const basePath = path.replace(/\*.*$/, "");
      // Skip /tmp — already mounted as tmpfs
      if (basePath === "/tmp" || basePath === "/tmp/") continue;
      result.push("--bind", basePath, basePath);
    }
  }

  // Deny overrides: overlay an empty tmpfs on denied subpaths to mask them.
  // This enforces denyRead/denyWrite even when a parent path was allowed above.
  if (fs.denyRead !== undefined) {
    for (const path of fs.denyRead) {
      if (isSystemPath(path)) continue;
      result.push("--tmpfs", path);
    }
  }
  if (fs.denyWrite !== undefined) {
    for (const path of fs.denyWrite) {
      if (isSystemPath(path)) continue;
      // Mount read-only bind of path over itself to revoke write permission
      result.push("--ro-bind", path, path);
    }
  }

  // Environment
  result.push("--clearenv");

  // Set PATH so commands can be found
  result.push("--setenv", "PATH", "/usr/bin:/bin:/usr/sbin:/sbin");

  if (profile.env !== undefined) {
    for (const [key, value] of Object.entries(profile.env)) {
      result.push("--setenv", key, value);
    }
  }

  // Resource limits via ulimit (if supported)
  if (profile.resources.maxOpenFiles !== undefined) {
    result.push("--", "sh", "-c", buildUlimitWrapper(profile, command, args));
  } else {
    // Command and args
    result.push(command, ...args);
  }

  return result;
}

function buildUlimitWrapper(
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
): string {
  const parts: string[] = [];

  if (profile.resources.maxOpenFiles !== undefined) {
    parts.push(`ulimit -n ${profile.resources.maxOpenFiles}`);
  }
  if (profile.resources.maxPids !== undefined) {
    parts.push(`ulimit -u ${profile.resources.maxPids}`);
  }

  const escapedCmd = [command, ...args].map(shellEscape).join(" ");
  parts.push(`exec ${escapedCmd}`);

  return parts.join(" && ");
}

function isSystemPath(path: string): boolean {
  const systemPaths = ["/usr", "/etc", "/bin", "/lib", "/sbin", "/dev", "/proc", "/tmp"];
  return systemPaths.some((sp) => path === sp || path.startsWith(`${sp}/`));
}

function shellEscape(s: string): string {
  // Wrap in single quotes, escaping any existing single quotes
  return `'${s.replace(/'/g, "'\\''")}'`;
}
