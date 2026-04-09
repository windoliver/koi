import { existsSync, mkdirSync, statSync } from "node:fs";

import type { SandboxProfile } from "@koi/core";

import { stripGlobSuffix } from "../path-utils.js";

function expandHome(path: string): string {
  if (!path.startsWith("~/")) return path;
  const home = process.env.HOME;
  return home !== undefined ? `${home}${path.slice(1)}` : path;
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/**
 * Push the appropriate bwrap deny args for `path` onto `args`.
 *
 * - Directory → `--tmpfs path` (empty overlay hides the directory tree)
 * - Regular file → `--bind /dev/null path` (bind-mount an empty file over it)
 * - Non-existent / other types → skip (nothing to hide)
 *
 * This handles credential files like `~/.netrc` that must not be exposed,
 * alongside directory stores like `~/.ssh` that are handled with tmpfs.
 */
function pushDenyArgs(args: string[], path: string): void {
  if (!existsSync(path)) return;
  try {
    const st = statSync(path);
    if (st.isDirectory()) {
      args.push("--tmpfs", path);
    } else if (st.isFile()) {
      // /dev/null always exists; bind-mounting it masks the file contents.
      args.push("--bind", "/dev/null", path);
    }
    // Symlinks, sockets, etc.: skip — uncommon in credential paths.
  } catch {
    // stat failed (e.g., broken symlink, race) — skip safely.
  }
}

function isSubpath(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Build the profile-constant portion of bubblewrap arguments.
 * Pre-computed once at adapter.create() time; exec() appends buildBwrapSuffix().
 *
 * Open mode: binds the entire host root read-only (`--ro-bind / /`), then
 * overlays /dev, /proc, /tmp with proper kernel namespaces, then applies
 * denyRead as --tmpfs overlays. This is the only correct way to implement
 * open-read semantics in bwrap — system-path enumeration is incomplete.
 *
 * Closed mode: no root bind; only explicit allowRead paths are mounted.
 *
 * Ordering invariant (security): --tmpfs deny overlays MUST appear after
 * their parent --ro-bind mounts, or bwrap will overwrite the tmpfs with the
 * real bind. Tests assert this ordering explicitly.
 */
export function buildBwrapPrefix(profile: SandboxProfile): readonly string[] {
  const args: string[] = ["bwrap", "--unshare-all", "--new-session", "--die-with-parent"];

  const isOpen = profile.filesystem.defaultReadAccess === "open";

  if (!profile.network.allow) {
    args.push("--unshare-net");
  }

  if (isOpen) {
    // Bind the entire host root read-only; /dev, /proc, /tmp overlaid below.
    args.push("--ro-bind", "/", "/");
  }

  // Always overlay kernel-special filesystems so namespaces are clean.
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");

  // Build deny set — expand ~/  now so depth sorting is correct.
  // Use a Set so we can track which deny paths have been assigned to a parent
  // mount, without mutating an array while iterating (Array.splice is banned).
  const unassignedDenies = new Set(
    [...(profile.filesystem.denyRead ?? [])]
      .map(expandHome)
      .sort((a, b) => pathDepth(a) - pathDepth(b)),
  );

  if (!isOpen) {
    // Closed mode: mount only explicit allowRead paths, then their deny children.
    for (const rawPath of profile.filesystem.allowRead ?? []) {
      const path = expandHome(rawPath);
      args.push("--ro-bind", path, path);

      // Apply deny overlays for children of this mount immediately after,
      // then remove from unassigned set to avoid double-applying in the
      // residual pass below.
      for (const deny of unassignedDenies) {
        if (isSubpath(path, deny)) {
          // Push --tmpfs (dirs) or --bind /dev/null (files); skip non-existent.
          pushDenyArgs(args, deny);
          unassignedDenies.delete(deny);
        }
      }
    }
  }

  // Open mode: apply all denyRead overlays over the root bind.
  // Closed mode: apply remaining deny entries not under any allowRead parent.
  // Guard: skip non-existent paths — bwrap cannot create mount points on a ro root.
  for (const path of unassignedDenies) {
    pushDenyArgs(args, path);
  }

  // Write mounts (after all read/deny mounts)
  for (const rawPath of profile.filesystem.allowWrite ?? []) {
    const path = expandHome(rawPath);
    if (path === "/tmp" || path.startsWith("/tmp/")) continue; // already tmpfs
    // stripGlobSuffix: validated upstream; no globs should reach here.
    const base = stripGlobSuffix(path);
    args.push("--bind", base, base);
  }

  // denyWrite: remount specific subtrees read-only AFTER the parent writable bind.
  // Ordering invariant: --ro-bind child must come after --bind parent.
  for (const rawPath of profile.filesystem.denyWrite ?? []) {
    args.push("--ro-bind", expandHome(rawPath), expandHome(rawPath));
  }

  // Environment
  args.push("--clearenv");
  // In open mode the host root is bound so standard system paths exist.
  // In closed mode only explicitly mounted paths exist — set PATH only if not overridden
  // by profile.env; callers using closed mode must supply the correct PATH themselves.
  if (isOpen && profile.env?.PATH === undefined) {
    args.push("--setenv", "PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
  }
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    args.push("--setenv", key, value);
  }

  return args;
}

/**
 * Ensure that denyRead directory paths exist so bwrap can mount tmpfs over them.
 *
 * bwrap's `--tmpfs PATH` needs PATH to exist as a directory *before* the
 * ro-bind root is in place — bwrap cannot create mount points inside a
 * read-only root.  For directory-typed denyRead entries that are absent on
 * the host (e.g. `~/.ssh` on a fresh container), we create them here.
 *
 * Only paths that do not already exist are created.  Paths that already exist
 * as regular files (e.g. `~/.netrc`) are intentionally skipped — they are
 * handled via `--bind /dev/null` in `buildBwrapPrefix()` instead.
 *
 * Call this in `createInstance` before `buildBwrapPrefix` — only relevant for bwrap.
 */
export function ensureDenyReadPaths(profile: SandboxProfile): void {
  for (const rawPath of profile.filesystem.denyRead ?? []) {
    const path = expandHome(rawPath);
    if (existsSync(path)) continue; // already exists (file or dir) — leave it alone
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      // Ignore: permission denied, parent is read-only, race, etc.
    }
  }
}

export function hasAnyUlimitResource(profile: SandboxProfile): boolean {
  return profile.resources.maxOpenFiles !== undefined || profile.resources.maxPids !== undefined;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildUlimitPrefix(profile: SandboxProfile): string {
  const parts: string[] = [];
  if (profile.resources.maxPids !== undefined) {
    parts.push(`ulimit -u ${profile.resources.maxPids}`);
  }
  if (profile.resources.maxOpenFiles !== undefined) {
    parts.push(`ulimit -n ${profile.resources.maxOpenFiles}`);
  }
  return parts.length === 0 ? "exec " : `${parts.join(" && ")} && exec `;
}

export function buildBwrapSuffix(
  profile: SandboxProfile,
  command: string,
  args: readonly string[],
): readonly string[] {
  if (hasAnyUlimitResource(profile)) {
    const cmd = `${buildUlimitPrefix(profile)}${[command, ...args].map(shellEscape).join(" ")}`;
    // Use /bin/bash by absolute path — bwrap's --clearenv clears PATH, so the
    // bare name 'bash' cannot be resolved in closed-mode sandboxes.
    // ulimit -u (max PIDs) is a bash extension; /bin/sh is dash on Ubuntu.
    return ["/bin/bash", "-c", cmd];
  }
  return [command, ...args];
}

/**
 * Build the systemd-run prefix args for cgroup v2 memory enforcement.
 *
 * Returns null when maxMemoryMb is not set — no wrapping needed.
 *
 * When returned, prepend these args to the full bwrap command:
 *   [...buildSystemdRunArgs(profile)!, ...buildBwrapPrefix(profile), ...buildBwrapSuffix(...)]
 *
 * Performance note: systemd-run scope creation adds ~10–50 ms per exec() call
 * due to D-Bus scope negotiation. This is irreducible when cgroup v2 memory
 * limits are required. For frequent short-lived sandboxes, omit maxMemoryMb
 * and rely on ulimit-only limits if the per-call overhead is unacceptable.
 *
 * Requires systemd-run in PATH. Caller must check availability at adapter
 * creation time (via Bun.which("systemd-run")) and handle the unavailable case.
 */
export function buildSystemdRunArgs(
  profile: SandboxProfile,
  unitName?: string,
): readonly string[] | null {
  const { maxMemoryMb } = profile.resources;
  if (maxMemoryMb === undefined) return null;
  const unitArgs = unitName !== undefined ? [`--unit=${unitName}`] : [];
  return ["systemd-run", "--user", "--scope", ...unitArgs, "-p", `MemoryMax=${maxMemoryMb}M`, "--"];
}
