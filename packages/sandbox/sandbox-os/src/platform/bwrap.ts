import type { SandboxProfile } from "@koi/core";

function expandHome(path: string): string {
  if (!path.startsWith("~/")) return path;
  const home = process.env["HOME"];
  return home !== undefined ? `${home}${path.slice(1)}` : path;
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
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

  // Build deny list — expand ~/  now so depth sorting is correct.
  const pendingDenyRead = [...(profile.filesystem.denyRead ?? [])]
    .map(expandHome)
    .sort((a, b) => pathDepth(a) - pathDepth(b));

  if (!isOpen) {
    // Closed mode: mount only explicit allowRead paths, then their deny children.
    for (const rawPath of profile.filesystem.allowRead ?? []) {
      const path = expandHome(rawPath);
      args.push("--ro-bind", path, path);

      // Apply deny overlays for children of this mount immediately after
      const children = pendingDenyRead.filter((d) => isSubpath(path, d));
      for (const child of children) {
        args.push("--tmpfs", child);
        pendingDenyRead.splice(pendingDenyRead.indexOf(child), 1);
      }
    }
  }

  // Open mode: apply all denyRead overlays over the root bind.
  // Closed mode: apply remaining deny entries not under any allowRead parent.
  for (const path of pendingDenyRead) {
    args.push("--tmpfs", path);
  }

  // Write mounts (after all read/deny mounts)
  for (const rawPath of profile.filesystem.allowWrite ?? []) {
    const path = expandHome(rawPath);
    if (path === "/tmp" || path.startsWith("/tmp/")) continue; // already tmpfs
    const base = path.replace(/\/?\*.*$/, "");
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
  if (isOpen && profile.env?.["PATH"] === undefined) {
    args.push("--setenv", "PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
  }
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    args.push("--setenv", key, value);
  }

  return args;
}

export function hasAnyResourceLimit(profile: SandboxProfile): boolean {
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
  if (hasAnyResourceLimit(profile)) {
    const cmd = `${buildUlimitPrefix(profile)}${[command, ...args].map(shellEscape).join(" ")}`;
    return ["sh", "-c", cmd];
  }
  return [command, ...args];
}
