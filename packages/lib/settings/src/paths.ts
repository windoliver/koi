import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { SettingsLayer } from "./types.js";

/** Resolved absolute path per layer, or null if that layer has no path. */
export type SettingsPaths = Record<SettingsLayer, string | null>;

interface ResolvePathsOptions {
  readonly cwd?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly flagPath?: string | undefined;
}

/**
 * Returns the absolute settings file path for each layer.
 *
 * Policy path is platform-specific:
 *   macOS  → /Library/Application Support/koi/policy.json
 *   Linux  → /etc/koi/policy.json
 *   other  → /etc/koi/policy.json
 */
export function resolveSettingsPaths(opts: ResolvePathsOptions = {}): SettingsPaths {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? homedir();

  return {
    user: join(home, ".koi", "settings.json"),
    project: join(cwd, ".koi", "settings.json"),
    local: join(cwd, ".koi", "settings.local.json"),
    flag: opts.flagPath ?? null,
    policy: resolvePolicyPath(),
  };
}

function resolvePolicyPath(): string {
  if (platform() === "darwin") {
    return "/Library/Application Support/koi/policy.json";
  }
  return "/etc/koi/policy.json";
}
