/**
 * Service installation orchestrator.
 *
 * Sequence: detect platform → resolve paths → render template → install → verify health.
 */

import { resolve } from "node:path";
import { createLaunchdManager } from "./managers/launchd.js";
import { createSystemdManager } from "./managers/systemd.js";
import type { ServiceManager } from "./managers/types.js";
import {
  detectBunPath,
  detectKoiPath,
  detectPlatform,
  type Platform,
  resolveLaunchdLabel,
  resolveLogDir,
  resolveServiceName,
} from "./platform.js";
import { renderLaunchdPlist } from "./templates/launchd.js";
import { renderSystemdUnit } from "./templates/systemd.js";
import type { DeployConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstallConfig {
  readonly agentName: string;
  readonly manifestPath: string;
  readonly deploy: DeployConfig;
  readonly workDir?: string | undefined;
}

export interface InstallResult {
  readonly platform: Platform;
  readonly serviceName: string;
  readonly serviceFilePath: string;
  readonly healthUrl: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function installService(config: InstallConfig): Promise<InstallResult> {
  const platform = detectPlatform();
  const bunPath = detectBunPath();
  const serviceName = resolveServiceName(config.agentName);
  const manifestPath = resolve(config.manifestPath);
  const workDir = config.workDir ?? process.cwd();

  const koiPath = detectKoiPath(workDir);

  const { port, restart, restartDelaySec, envFile, system } = config.deploy;
  const logDir = config.deploy.logDir ?? resolveLogDir(platform, serviceName);

  let serviceContent: string;
  let manager: ServiceManager;

  if (platform === "linux") {
    serviceContent = renderSystemdUnit({
      name: config.agentName,
      bunPath,
      koiPath,
      manifestPath,
      workDir,
      port,
      restart,
      restartDelaySec,
      system,
      envFile,
      dataDir: workDir,
      user: undefined, // systemd user services don't need User=
    });
    manager = createSystemdManager(system);
  } else {
    const label = resolveLaunchdLabel(config.agentName);
    serviceContent = renderLaunchdPlist({
      label,
      name: config.agentName,
      bunPath,
      koiPath,
      manifestPath,
      workDir,
      port,
      restartDelaySec,
      logDir,
      envFile,
    });
    manager = createLaunchdManager(system, logDir);
  }

  // Install and start
  await manager.install(serviceName, serviceContent);
  await manager.start(serviceName);

  const healthUrl = `http://localhost:${port}/health`;

  return {
    platform,
    serviceName,
    serviceFilePath: manifestPath,
    healthUrl,
  };
}
