/**
 * PATH scanner — discovers external agents by scanning the system PATH.
 *
 * Uses injectable SystemCalls for full testability. Defaults to Bun.which()
 * when no SystemCalls are provided.
 */

import type { ExternalAgentDescriptor } from "@koi/core";
import { KNOWN_CLI_AGENTS } from "../constants.js";
import type { DiscoverySource, KnownCliAgent, SystemCalls } from "../types.js";

/** Default SystemCalls using Bun runtime APIs. */
function createDefaultSystemCalls(): SystemCalls {
  return {
    which: (cmd: string): string | null => Bun.which(cmd),
    exec: async (
      cmd: string,
      args: readonly string[],
      timeoutMs: number,
    ): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
      const proc = Bun.spawn([cmd, ...args], {
        stdout: "pipe",
        stderr: "ignore",
        timeout: timeoutMs,
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { exitCode, stdout: stdout.trim() };
    },
  };
}

export interface PathSourceConfig {
  readonly knownAgents?: readonly KnownCliAgent[] | undefined;
  readonly systemCalls?: SystemCalls | undefined;
}

/**
 * Creates a DiscoverySource that scans the system PATH for known CLI agents.
 * Binary found on PATH = present (healthy: true).
 */
export function createPathSource(config?: PathSourceConfig): DiscoverySource {
  const agents = config?.knownAgents ?? KNOWN_CLI_AGENTS;
  const sys = config?.systemCalls ?? createDefaultSystemCalls();

  return {
    name: "path",

    discover: async (): Promise<readonly ExternalAgentDescriptor[]> => {
      return agents.flatMap((agent) => {
        const matchedBinary = agent.binaries.find((binary) => sys.which(binary) !== null);
        if (matchedBinary === undefined) return [];
        return [
          {
            name: agent.name,
            displayName: agent.displayName,
            transport: agent.transport,
            command: matchedBinary,
            capabilities: agent.capabilities,
            healthy: true as const,
            source: "path" as const,
            protocol: agent.protocol,
            metadata: { versionFlag: agent.versionFlag },
          },
        ];
      });
    },
  };
}
