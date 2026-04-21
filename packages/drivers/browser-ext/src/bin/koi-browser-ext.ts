#!/usr/bin/env node

import { formatInstallSummary, runInstallCommand } from "./install.js";
import { formatStatusSummary, runStatusCommand } from "./status.js";
import { formatUninstallSummary, runUninstallCommand } from "./uninstall.js";

function usage(): string {
  return [
    "Usage: koi-browser-ext <install|uninstall|status> [--dev] [--help]",
    "",
    "Commands:",
    "  install      Install native messaging manifests, auth files, wrapper, and extension bundle.",
    "  uninstall    Online-only uninstall that clears grants before removing local files.",
    "  status       Show current live host and local install state.",
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  switch (command) {
    case "install": {
      const result = await runInstallCommand({
        dev: !rest.includes("--release"),
      });
      process.stdout.write(`${formatInstallSummary(result)}\n`);
      return;
    }
    case "uninstall": {
      const result = await runUninstallCommand();
      process.stdout.write(`${formatUninstallSummary(result)}\n`);
      return;
    }
    case "status": {
      const result = await runStatusCommand();
      process.stdout.write(`${formatStatusSummary(result)}\n`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
