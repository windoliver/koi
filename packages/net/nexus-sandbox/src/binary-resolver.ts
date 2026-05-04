/**
 * Resolve the argv used to launch the Nexus server daemon.
 *
 * The actual server binary is `nexusd` (not `nexus serve` — the CLI
 * `nexus` command does not expose a `serve` subcommand). Verified
 * against nexus-ai-fs `main` after PR nexi-lab/nexus#4018.
 *
 * Priority:
 *   1. `opts.command` — explicit argv override
 *   2. `NEXUS_COMMAND` env var — space-separated argv
 *   3. `opts.sourceDir` — `uv run --directory <sourceDir> nexusd` (contributor mode)
 *   4. Default: `uvx --from nexus-ai-fs nexusd` (isolated, no PATH conflicts)
 *
 * Returned argv does NOT include profile/port/host flags — those are
 * appended by `lifecycle.startSandbox` so `resolveCommand` is
 * testable on its own.
 */

import type { ResolveCommandOptions } from "./types.js";

const DEFAULT_ARGV: readonly string[] = Object.freeze(["uvx", "--from", "nexus-ai-fs", "nexusd"]);

export function resolveCommand(opts: ResolveCommandOptions = {}): readonly string[] {
  if (opts.command !== undefined && opts.command.length > 0) {
    return Object.freeze([...opts.command]);
  }
  const envOverride = process.env.NEXUS_COMMAND;
  if (envOverride !== undefined && envOverride.trim().length > 0) {
    return Object.freeze(envOverride.trim().split(/\s+/));
  }
  if (opts.sourceDir !== undefined) {
    return Object.freeze(["uv", "run", "--directory", opts.sourceDir, "nexusd"]);
  }
  return DEFAULT_ARGV;
}
