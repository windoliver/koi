import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import type { SettingsLayer } from "./types.js";

/** Resolved absolute path per layer, or null if that layer has no path. */
export type SettingsPaths = Record<SettingsLayer, string | null>;

interface ResolvePathsOptions {
  readonly cwd?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly flagPath?: string | undefined;
  readonly policyPath?: string | undefined;
}

/**
 * Returns the absolute settings file path for each layer.
 *
 * Policy path is platform-specific:
 *   macOS  → /Library/Application Support/koi/policy.json
 *   Linux  → /etc/koi/policy.json
 *   other  → /etc/koi/policy.json
 *
 * Project/local layers are resolved from the nearest project root (git root
 * or first ancestor that contains a `.koi/` directory), so `koi` launched from
 * a subdirectory still finds the repo-level settings file.
 *
 * Callers may supply `policyPath` to override the platform default (used in tests).
 */
export function resolveSettingsPaths(opts: ResolvePathsOptions = {}): SettingsPaths {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? homedir();
  const projectRoot = findProjectRoot(cwd);

  return {
    user: join(home, ".koi", "settings.json"),
    project: join(projectRoot, ".koi", "settings.json"),
    local: join(projectRoot, ".koi", "settings.local.json"),
    flag: opts.flagPath ?? null,
    policy: opts.policyPath ?? resolvePolicyPath(),
  };
}

/**
 * Walk up from `startDir` to find the project root.
 *
 * Stops at the first ancestor that contains a `.git` directory (git repo root)
 * or a `.koi/` directory (explicit koi workspace). Falls back to `startDir`
 * if neither is found before the filesystem root.
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".koi"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return startDir; // filesystem root — give up
    dir = parent;
  }
}

function resolvePolicyPath(): string {
  if (platform() === "darwin") {
    return "/Library/Application Support/koi/policy.json";
  }
  return "/etc/koi/policy.json";
}
