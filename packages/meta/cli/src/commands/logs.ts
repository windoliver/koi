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
import { loadManifest } from "@koi/manifest";
import { EXIT_CONFIG } from "@koi/shutdown/exit-codes";
import type { LogsFlags } from "../args.js";

export async function runLogs(flags: LogsFlags): Promise<void> {
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";

  const loadResult = await loadManifest(manifestPath, undefined, { rejectUnsupportedHooks: false });
  if (!loadResult.ok) {
    process.stderr.write(`Failed to load manifest: ${loadResult.error.message}\n`);
    process.exit(EXIT_CONFIG);
  }

  const { manifest, warnings } = loadResult.value;
  for (const w of warnings) {
    process.stderr.write(`warn: ${w.message}\n`);
  }
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
