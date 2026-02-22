/**
 * macOS Seatbelt (sandbox-exec) profile generation and command building.
 * Pure functions — no side effects.
 *
 * Strategy: deny-default with broad file-read (required by dyld/frameworks),
 * then deny sensitive read paths explicitly. File writes use an allow-list.
 */

import type { SandboxProfile } from "../types.js";

/**
 * Generate a Seatbelt .sb profile string from a SandboxProfile.
 * Uses deny-default with a deny-list approach for reads (macOS dyld requires
 * broad read access to function) and an allow-list for writes.
 */
export function generateSeatbeltProfile(profile: SandboxProfile, _command: string): string {
  const lines: string[] = ["(version 1)", "(deny default)"];

  // Process execution — required for spawning the target command
  lines.push("(allow process*)");
  lines.push("(allow sysctl*)");
  lines.push("(allow mach*)");
  lines.push("(allow signal)");

  // Broad file-read: macOS dyld, frameworks, and system libs need wide read access.
  // We use a deny-list to block sensitive paths instead of trying to enumerate
  // every system path (which is fragile across macOS versions).
  lines.push("(allow file-read-data)");
  lines.push("(allow file-read-metadata)");

  // Deny reads for sensitive paths (from profile.filesystem.denyRead)
  const fs = profile.filesystem;
  if (fs.denyRead !== undefined) {
    for (const path of fs.denyRead) {
      const resolved = resolvePath(path);
      if (resolved !== null) {
        lines.push(`(deny file-read* (subpath "${escapeSeatbeltPath(resolved)}"))`);
      }
    }
  }

  // File writes: deny-default is already active, so we allow specific paths
  lines.push("(deny file-write*)");
  lines.push('(allow file-write* (literal "/dev/null"))');

  if (fs.allowWrite !== undefined) {
    for (const path of fs.allowWrite) {
      const basePath = path.replace(/\*.*$/, "");
      const resolved = resolvePath(basePath);
      if (resolved !== null) {
        lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(resolved)}"))`);
      }
    }
  }

  // Network rules
  if (!profile.network.allow) {
    lines.push("(deny network*)");
  } else {
    lines.push("(allow network*)");
  }

  return lines.join("\n");
}

/**
 * Build the full command-line args for sandbox-exec.
 */
export function buildSeatbeltArgs(
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
): readonly string[] {
  const seatbeltProfile = generateSeatbeltProfile(profile, command);
  return ["sandbox-exec", "-p", seatbeltProfile, command, ...args];
}

/**
 * Resolve paths with tilde to absolute paths.
 * Returns null for patterns that can't be resolved to valid seatbelt paths.
 */
function resolvePath(path: string): string | null {
  if (path.startsWith("~/")) {
    const home = process.env.HOME;
    if (home === undefined) return null;
    return `${home}${path.slice(1)}`;
  }
  if (path.startsWith("~")) {
    // Bare ~ or ~user — skip (not a valid pattern for seatbelt)
    return null;
  }
  // Relative patterns like ".env" can't be used as seatbelt subpaths
  if (!path.startsWith("/")) {
    return null;
  }
  return path;
}

function escapeSeatbeltPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
