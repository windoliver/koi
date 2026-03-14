/**
 * Demo pack seeding and agent provisioning phases.
 */

import { readFile } from "node:fs/promises";
import type { NexusClient } from "@koi/nexus-client";
import type { createAgentDispatcher } from "../../agent-dispatcher.js";
import type { ProvisionedAgent } from "./types.js";

export interface SeedDemoResult {
  readonly prompts: readonly string[];
  readonly seededBricks: readonly import("@koi/demo-packs").SeededBrickView[];
}

const EMPTY_RESULT: SeedDemoResult = { prompts: [], seededBricks: [] };

export async function seedDemoPackIfNeeded(
  demoPack: string | undefined,
  workspaceRoot: string,
  agentName: string,
  nexusClient: NexusClient | undefined,
  verbose: boolean,
): Promise<SeedDemoResult> {
  if (demoPack === undefined) return EMPTY_RESULT;

  try {
    const { join } = await import("node:path");

    const markerPath = join(workspaceRoot, ".koi", ".demo-seeded");
    try {
      await readFile(markerPath, "utf-8");
      // Already seeded — still return prompts and run seed to get brick views
      const { getPack, runSeed } = await import("@koi/demo-packs");
      const pack = getPack(demoPack);
      // Re-run seed to get seeded brick views (idempotent writes to Nexus)
      if (nexusClient !== undefined && pack !== undefined) {
        const result = await runSeed(demoPack, { nexusClient, agentName, workspaceRoot, verbose });
        return { prompts: pack.prompts, seededBricks: result.seededBricks ?? [] };
      }
      return { prompts: pack?.prompts ?? [], seededBricks: [] };
    } catch {
      // Marker doesn't exist — proceed with seeding
    }

    if (nexusClient === undefined) {
      process.stderr.write("warn: demo pack requires Nexus — skipping auto-seed\n");
      return EMPTY_RESULT;
    }

    const { getPack, runSeed } = await import("@koi/demo-packs");
    const pack = getPack(demoPack);

    if (pack === undefined) {
      process.stderr.write(`Unknown demo pack "${demoPack}". Run 'koi demo list'.\n`);
      return EMPTY_RESULT;
    }

    const result = await runSeed(demoPack, {
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
      await writeFile(markerPath, demoPack);
    }

    return { prompts: pack.prompts, seededBricks: result.seededBricks ?? [] };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes("ECONNREFUSED")) {
      const msg = nexusClient !== undefined ? "" : " — is it running?";
      process.stderr.write(`warn: cannot reach Nexus${msg}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`warn: demo pack seeding failed: ${message}\n`);
    }
    return EMPTY_RESULT;
  }
}

/**
 * Provisions helper agents declared in the demo pack's agentRoles.
 * Skips the "primary" role (already running as the main runtime).
 */
export async function provisionDemoAgents(
  demoPack: string | undefined,
  manifestPath: string,
  dispatcher: ReturnType<typeof createAgentDispatcher> | undefined,
  verbose: boolean,
): Promise<readonly ProvisionedAgent[]> {
  if (dispatcher === undefined || demoPack === undefined) return [];

  try {
    const { getPack } = await import("@koi/demo-packs");
    const pack = getPack(demoPack);
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
