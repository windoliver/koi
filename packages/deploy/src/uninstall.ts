/**
 * Service uninstallation orchestrator.
 *
 * Sequence: detect platform → stop service → disable → remove service file.
 */

import { createLaunchdManager } from "./managers/launchd.js";
import { createSystemdManager } from "./managers/systemd.js";
import type { ServiceManager } from "./managers/types.js";
import { detectPlatform, type Platform, resolveLogDir, resolveServiceName } from "./platform.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UninstallConfig {
  readonly agentName: string;
  readonly system: boolean;
  readonly logDir?: string | undefined;
}

export interface UninstallResult {
  readonly platform: Platform;
  readonly serviceName: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function uninstallService(config: UninstallConfig): Promise<UninstallResult> {
  const platform = detectPlatform();
  const serviceName = resolveServiceName(config.agentName);
  const logDir = config.logDir ?? resolveLogDir(platform, serviceName);

  let manager: ServiceManager;

  if (platform === "linux") {
    manager = createSystemdManager(config.system);
  } else {
    manager = createLaunchdManager(config.system, logDir);
  }

  // Stop then uninstall
  const status = await manager.status(serviceName);
  if (status === "running") {
    await manager.stop(serviceName);
  }

  await manager.uninstall(serviceName);

  return { platform, serviceName };
}
