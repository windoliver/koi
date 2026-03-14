/**
 * BANNER phase — print colored startup summary.
 */

import { bold, cyan, green } from "@koi/cli-render";
import type { BannerInfo } from "./types.js";

export function printBanner(info: BannerInfo): void {
  const err = process.stderr;

  err.write("\n");
  err.write(`${bold(`Starting Koi ${info.presetId} preset...`)}\n`);

  if (info.nexusBaseUrl !== undefined) {
    const modeLabel = info.nexusMode === "embed-auth" ? "full" : info.nexusMode;
    err.write(`  ${green("\u2713")} Nexus ready at ${cyan(info.nexusBaseUrl)} (${modeLabel})\n`);
  }

  err.write(
    `  ${green("\u2713")} Primary agent ${bold(`"${info.agentName}"`)} ready (${info.engineName}, ${info.modelName})\n`,
  );

  for (const agent of info.provisionedAgents) {
    err.write(`  ${green("\u2713")} ${agent.role} ${bold(`"${agent.name}"`)} ready\n`);
  }

  if (info.temporalAdmin !== undefined && info.temporalUrl !== undefined) {
    err.write(`  ${green("\u2713")} Temporal ready at ${cyan(info.temporalUrl)}\n`);
  } else if (info.temporalAdmin !== undefined) {
    err.write(`  ${green("\u2713")} Temporal orchestration connected\n`);
  }

  for (const src of info.discoveredSources) {
    err.write(`  ${green("\u2713")} Source ${bold(`"${src.name}"`)} (${src.protocol})\n`);
  }

  for (const ch of info.channels) {
    err.write(`  ${green("\u2713")} Channel ${bold(`"${ch.name}"`)} connected\n`);
  }

  if (info.adminReady) {
    err.write(
      `  ${green("\u2713")} Admin API ready at ${cyan("http://localhost:3100/admin/api")}\n`,
    );
    err.write(`  ${green("\u2713")} Browser admin at ${cyan("http://localhost:3100/admin")}\n`);
  }

  err.write("\n");
}
