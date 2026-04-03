/**
 * `koi deploy` command — install/uninstall OS background service.
 *
 * Orchestrates: load manifest → detect platform → generate service file → install.
 */

import { resolve } from "node:path";
import { detectPlatform, installService, uninstallService } from "@koi/deploy";
import type { DeployFlags } from "../args.js";
import { loadManifestOrExit } from "../load-manifest-or-exit.js";

// ---------------------------------------------------------------------------
// Default deploy config when manifest has no deploy: section
// ---------------------------------------------------------------------------

const DEFAULT_DEPLOY = {
  port: 9100,
  restart: "on-failure" as const,
  restartDelaySec: 5,
  envFile: undefined,
  logDir: undefined,
  system: false,
};

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runDeploy(flags: DeployFlags): Promise<void> {
  // 1. Load manifest
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
  const { manifest } = await loadManifestOrExit(manifestPath);

  // 2. Merge deploy config: manifest.deploy → flag overrides → defaults
  const manifestDeploy = manifest.deploy ?? DEFAULT_DEPLOY;
  const deployConfig = {
    port: flags.port ?? manifestDeploy.port,
    restart: manifestDeploy.restart,
    restartDelaySec: manifestDeploy.restartDelaySec,
    envFile: manifestDeploy.envFile,
    logDir: manifestDeploy.logDir,
    system: flags.system || manifestDeploy.system,
  };

  // 3. Handle uninstall
  if (flags.uninstall) {
    process.stderr.write(`Removing service for "${manifest.name}"...\n`);

    const result = await uninstallService({
      agentName: manifest.name,
      system: deployConfig.system,
      logDir: deployConfig.logDir,
    });

    process.stderr.write(`Service "${result.serviceName}" removed (${result.platform}).\n`);
    return;
  }

  // 4. Install
  const platform = detectPlatform();

  process.stderr.write(`Deploying "${manifest.name}" as ${platform} service...\n`);

  const result = await installService({
    agentName: manifest.name,
    manifestPath: resolve(manifestPath),
    deploy: deployConfig,
  });

  process.stderr.write(`\nService installed:\n`);
  process.stderr.write(`  Name:     ${result.serviceName}\n`);
  process.stderr.write(`  Platform: ${result.platform}\n`);
  process.stderr.write(`  Health:   ${result.healthUrl}\n`);
  process.stderr.write(`\nManage with:\n`);
  process.stderr.write(`  koi status ${manifestPath}\n`);
  process.stderr.write(`  koi logs ${manifestPath}\n`);
  process.stderr.write(`  koi stop ${manifestPath}\n`);
  process.stderr.write(`  koi deploy --uninstall ${manifestPath}\n`);
}
