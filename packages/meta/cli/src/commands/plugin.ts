/**
 * `koi plugin` — plugin lifecycle management.
 *
 * Subcommands: install, remove, enable, disable, update, list.
 */

import { resolve } from "node:path";
import type { PluginError, PluginListEntry } from "@koi/plugins";
import {
  createPluginRegistry,
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPlugins,
  removePlugin,
  updatePlugin,
} from "@koi/plugins";
import type { CliFlags } from "../args.js";
import { isPluginFlags } from "../args.js";
import type { JsonOutput } from "../types.js";
import { ExitCode } from "../types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_USER_ROOT = resolve(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".koi",
  "plugins",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a lifecycle config with an ungated registry.
 * The CLI operates on the filesystem (install/remove/update) and shows
 * all plugins including disabled ones for admin visibility.
 * Runtime consumers should use createGatedRegistry() to enforce
 * enable/disable semantics at the discovery/load boundary.
 */
function createConfig(): {
  readonly userRoot: string;
  readonly registry: ReturnType<typeof createPluginRegistry>;
} {
  const userRoot = DEFAULT_USER_ROOT;
  const registry = createPluginRegistry({ userRoot });
  return { userRoot, registry };
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isPluginFlags(flags)) return ExitCode.FAILURE;

  const config = createConfig();

  switch (flags.subcommand) {
    case "install": {
      if (flags.path === undefined) {
        process.stderr.write("error: koi plugin install requires a source path\n");
        return ExitCode.FAILURE;
      }
      const result = await installPlugin(config, resolve(flags.path));
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        return ExitCode.FAILURE;
      }
      process.stdout.write(
        `Installed plugin "${result.value.name}" v${result.value.version} (${result.value.source})\n`,
      );
      return ExitCode.OK;
    }

    case "remove": {
      if (flags.name === undefined) {
        process.stderr.write("error: koi plugin remove requires a plugin name\n");
        return ExitCode.FAILURE;
      }
      const result = await removePlugin(config, flags.name);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        return ExitCode.FAILURE;
      }
      process.stdout.write(`Removed plugin "${flags.name}"\n`);
      return ExitCode.OK;
    }

    case "enable": {
      if (flags.name === undefined) {
        process.stderr.write("error: koi plugin enable requires a plugin name\n");
        return ExitCode.FAILURE;
      }
      const result = await enablePlugin(config, flags.name);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        return ExitCode.FAILURE;
      }
      process.stdout.write(`Enabled plugin "${flags.name}"\n`);
      return ExitCode.OK;
    }

    case "disable": {
      if (flags.name === undefined) {
        process.stderr.write("error: koi plugin disable requires a plugin name\n");
        return ExitCode.FAILURE;
      }
      const result = await disablePlugin(config, flags.name);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        return ExitCode.FAILURE;
      }
      process.stdout.write(`Disabled plugin "${flags.name}"\n`);
      return ExitCode.OK;
    }

    case "update": {
      if (flags.name === undefined || flags.path === undefined) {
        process.stderr.write("error: koi plugin update requires <name> <path>\n");
        return ExitCode.FAILURE;
      }
      const result = await updatePlugin(config, flags.name, resolve(flags.path));
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        return ExitCode.FAILURE;
      }
      process.stdout.write(`Updated plugin "${result.value.name}" to v${result.value.version}\n`);
      return ExitCode.OK;
    }

    case "list": {
      const result = await listPlugins(config);
      if (!result.ok) {
        process.stderr.write(`error: ${result.error.message}\n`);
        return ExitCode.FAILURE;
      }

      const { entries, errors } = result.value;

      if (flags.json) {
        const output: JsonOutput<{
          readonly plugins: readonly {
            readonly name: string;
            readonly version: string;
            readonly source: string;
            readonly enabled: boolean;
          }[];
          readonly errors: readonly {
            readonly dirPath: string;
            readonly source: string;
            readonly code: string;
            readonly message: string;
          }[];
        }> = {
          ok: true,
          data: {
            plugins: entries.map((e: PluginListEntry) => ({
              name: e.meta.name,
              version: e.meta.version,
              source: e.meta.source,
              enabled: e.enabled,
            })),
            errors: errors.map((e: PluginError) => ({
              dirPath: e.dirPath,
              source: e.source,
              code: e.error.code,
              message: e.error.message,
            })),
          },
        };
        process.stdout.write(`${JSON.stringify(output)}\n`);
        // Non-zero exit when any plugin was rejected, so scripts can detect
        // problems without parsing stdout. Humans still see the full report.
        return errors.length > 0 ? ExitCode.FAILURE : ExitCode.OK;
      }

      if (entries.length === 0 && errors.length === 0) {
        process.stdout.write("No plugins installed.\n");
        return ExitCode.OK;
      }

      if (entries.length > 0) {
        const nameWidth = Math.max(4, ...entries.map((e: PluginListEntry) => e.meta.name.length));
        const verWidth = Math.max(7, ...entries.map((e: PluginListEntry) => e.meta.version.length));
        process.stdout.write(
          `  ${"NAME".padEnd(nameWidth)}  ${"VERSION".padEnd(verWidth)}  ${"SOURCE".padEnd(7)}  STATUS\n`,
        );
        process.stdout.write(
          `  ${"─".repeat(nameWidth)}  ${"─".repeat(verWidth)}  ${"─".repeat(7)}  ${"─".repeat(8)}\n`,
        );
        for (const entry of entries) {
          const status = entry.enabled ? "enabled" : "disabled";
          process.stdout.write(
            `  ${entry.meta.name.padEnd(nameWidth)}  ${entry.meta.version.padEnd(verWidth)}  ${entry.meta.source.padEnd(7)}  ${status}\n`,
          );
        }
      }

      // Surface per-plugin discovery errors so rejected manifests (typos,
      // schema violations, etc.) aren't invisible to the user.
      if (errors.length > 0) {
        process.stderr.write(
          `\n${errors.length} plugin${errors.length === 1 ? "" : "s"} rejected:\n`,
        );
        for (const e of errors) {
          process.stderr.write(
            `  ✗ ${e.dirPath}\n    [${e.source}] ${e.error.code}: ${e.error.message}\n`,
          );
        }
        return ExitCode.FAILURE;
      }

      return ExitCode.OK;
    }

    default:
      return ExitCode.FAILURE;
  }
}
