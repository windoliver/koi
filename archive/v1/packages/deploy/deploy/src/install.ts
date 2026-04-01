/**
 * Service installation orchestrator.
 *
 * Sequence: detect platform → resolve paths → generate template → install → verify health.
 */

import { join, resolve } from "node:path";
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
  resolveServiceDir,
  resolveServiceName,
} from "./platform.js";
import { generateLaunchdPlist } from "./templates/launchd.js";
import { generateSystemdUnit } from "./templates/systemd.js";
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
  let serviceFilePath: string;

  if (platform === "linux") {
    serviceContent = generateSystemdUnit({
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
    serviceFilePath = join(resolveServiceDir("linux", system), `${serviceName}.service`);
  } else {
    const label = resolveLaunchdLabel(config.agentName);
    serviceContent = generateLaunchdPlist({
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
    serviceFilePath = join(resolveServiceDir("darwin", system), `${label}.plist`);
  }

  // Install and start
  await manager.install(serviceName, serviceContent);
  await manager.start(serviceName);

  const healthUrl = `http://localhost:${port}/health`;

  // Best-effort health check: retry a few times with a short delay
  await verifyHealth(healthUrl);

  return {
    platform,
    serviceName,
    serviceFilePath,
    healthUrl,
  };
}

// ---------------------------------------------------------------------------
// Health verification
// ---------------------------------------------------------------------------

const HEALTH_MAX_RETRIES = 3;
const HEALTH_RETRY_DELAY_MS = 1_000;
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Best-effort health verification after service start.
 * Retries up to {@link HEALTH_MAX_RETRIES} times with a delay between attempts.
 * Failures are intentionally swallowed — the service may not expose HTTP yet,
 * or it may need more time to become ready.
 */
async function verifyHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < HEALTH_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Network error or timeout — retry after delay
    }

    if (attempt < HEALTH_MAX_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_DELAY_MS));
    }
  }
  // All retries exhausted — proceed silently.
  // The caller can run `koi doctor` for detailed diagnostics.
}
