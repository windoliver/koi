/**
 * Demo pack seeding and agent provisioning phases.
 */

import { readFile } from "node:fs/promises";
import type { createAgentDispatcher } from "../../agent-dispatcher.js";
import type { ProvisionedAgent } from "./types.js";

export async function seedDemoPackIfNeeded(
  manifestPath: string,
  workspaceRoot: string,
  agentName: string,
  nexusBaseUrl: string | undefined,
  verbose: boolean,
): Promise<void> {
  try {
    const { join } = await import("node:path");

    const raw = await readFile(manifestPath, "utf-8");
    const demoMatch = /^demo:\s*\n\s+pack:\s*(\S+)/m.exec(raw);
    if (demoMatch === null) return;

    const packId = demoMatch[1];
    if (packId === undefined) return;

    const markerPath = join(workspaceRoot, ".koi", ".demo-seeded");
    try {
      await readFile(markerPath, "utf-8");
      return;
    } catch {
      // Marker doesn't exist — proceed with seeding
    }

    if (nexusBaseUrl === undefined) {
      process.stderr.write("warn: demo pack requires Nexus — skipping auto-seed\n");
      return;
    }

    const { runSeed } = await import("@koi/demo-packs");
    const { createNexusClient } = await import("@koi/nexus-client");
    const apiKey = process.env.NEXUS_API_KEY;
    const nexusClient = createNexusClient({
      baseUrl: nexusBaseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });

    const result = await runSeed(packId, {
      nexusClient,
      agentName,
      workspaceRoot,
      verbose,
    });

    for (const line of result.summary) {
      process.stderr.write(`  ${line}\n`);
    }

    if (result.ok) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const pidDir = join(workspaceRoot, ".koi");
      await mkdir(pidDir, { recursive: true });
      await writeFile(markerPath, packId);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: demo pack seeding failed: ${message}\n`);
  }
}

/**
 * Provisions helper agents declared in the demo pack's agentRoles.
 * Skips the "primary" role (already running as the main runtime).
 */
export async function provisionDemoAgents(
  manifestPath: string,
  dispatcher: ReturnType<typeof createAgentDispatcher> | undefined,
  verbose: boolean,
): Promise<readonly ProvisionedAgent[]> {
  if (dispatcher === undefined) return [];

  try {
    const raw = await readFile(manifestPath, "utf-8");
    const demoMatch = /^demo:\s*\n\s+pack:\s*(\S+)/m.exec(raw);
    if (demoMatch === null) return [];

    const packId = demoMatch[1];
    if (packId === undefined) return [];

    const { getPack } = await import("@koi/demo-packs");
    const pack = getPack(packId);
    if (pack === undefined) return [];

    const provisioned: ProvisionedAgent[] = [];

    for (const role of pack.agentRoles) {
      if (role.name === "primary") continue;

      const result = await dispatcher.dispatchAgent({
        name: `${role.name} (${role.type})`,
        manifest: manifestPath,
        message: role.description,
        agentType: role.type,
      });

      if (result.ok) {
        provisioned.push({ name: role.name, role: role.type });
        if (verbose) {
          process.stderr.write(
            `Provisioned ${role.type} "${role.name}": ${result.value.agentId}\n`,
          );
        }
      } else if (verbose) {
        process.stderr.write(
          `warn: failed to provision ${role.type} "${role.name}": ${result.error.message}\n`,
        );
      }
    }

    return provisioned;
  } catch {
    return [];
  }
}
