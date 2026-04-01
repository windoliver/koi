/**
 * `koi logs` command — view service logs.
 */

import {
  createLaunchdManager,
  createSystemdManager,
  detectPlatform,
  resolveLogDir,
  resolveServiceName,
} from "@koi/deploy";
import type { LogsFlags } from "../args.js";
import { loadManifestOrExit } from "../load-manifest-or-exit.js";

export async function runLogs(flags: LogsFlags): Promise<void> {
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
  const { manifest } = await loadManifestOrExit(manifestPath);
  const platform = detectPlatform();
  const serviceName = resolveServiceName(manifest.name);
  const system = manifest.deploy?.system ?? false;
  const logDir = manifest.deploy?.logDir ?? resolveLogDir(platform, serviceName);

  const manager =
    platform === "linux" ? createSystemdManager(system) : createLaunchdManager(system, logDir);

  const info = await manager.status(serviceName);
  if (info.status === "not-installed") {
    process.stderr.write(`Service "${serviceName}" is not installed.\n`);
    return;
  }

  for await (const chunk of manager.logs(serviceName, {
    follow: flags.follow,
    lines: flags.lines,
  })) {
    process.stdout.write(chunk);
  }
}
