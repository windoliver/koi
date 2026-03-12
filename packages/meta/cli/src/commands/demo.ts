/**
 * `koi demo` subcommand — manage demo data.
 *
 * Subcommands:
 * - `koi demo init [pack]` — seed demo data
 * - `koi demo list` — list available demo packs
 * - `koi demo reset [pack]` — clear seeded data
 */

import { dirname, resolve } from "node:path";
import { loadManifest } from "@koi/manifest";
import { EXIT_CONFIG } from "@koi/shutdown";
import type { DemoFlags } from "../args.js";

export async function runDemo(flags: DemoFlags): Promise<void> {
  switch (flags.subcommand) {
    case "init":
      await runDemoInit(flags);
      break;
    case "list":
      await runDemoList();
      break;
    case "reset":
      await runDemoReset(flags);
      break;
    default:
      process.stderr.write("Usage:\n");
      process.stderr.write("  koi demo init [pack]   Seed demo data\n");
      process.stderr.write("  koi demo list          List available demo packs\n");
      process.stderr.write("  koi demo reset [pack]  Clear seeded data\n");
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// koi demo init
// ---------------------------------------------------------------------------

async function runDemoInit(flags: DemoFlags): Promise<void> {
  const packId = flags.pack ?? "connected";

  // Lazy-import demo-packs to keep the main CLI bundle lean
  const { getPack, runSeed } = await import("@koi/demo-packs");

  const pack = getPack(packId);
  if (pack === undefined) {
    const { PACK_IDS } = await import("@koi/demo-packs");
    process.stderr.write(`Unknown demo pack: "${packId}". Available: ${PACK_IDS.join(", ")}\n`);
    process.exit(1);
  }

  // Load manifest to get agent name and workspace root
  const manifestPath = flags.manifest ?? "koi.yaml";
  const loadResult = await loadManifest(manifestPath);
  if (!loadResult.ok) {
    process.stderr.write(`Failed to load manifest: ${loadResult.error.message}\n`);
    process.exit(EXIT_CONFIG);
  }

  const { manifest } = loadResult.value;
  const workspaceRoot = resolve(dirname(manifestPath));

  // Create Nexus client for seeding
  const { createNexusClient } = await import("@koi/nexus-client");
  const nexusUrl = process.env.NEXUS_URL ?? "http://127.0.0.1:2026";
  const nexusClient = createNexusClient({
    baseUrl: nexusUrl,
    ...(process.env.NEXUS_API_KEY !== undefined ? { apiKey: process.env.NEXUS_API_KEY } : {}),
  });

  process.stderr.write(`Seeding demo: ${pack.name}...\n`);

  const result = await runSeed(packId, {
    nexusClient,
    agentName: manifest.name,
    workspaceRoot,
    verbose: flags.verbose,
  });

  // Print results
  for (const line of result.summary) {
    process.stderr.write(`  \u2713 ${line}\n`);
  }

  if (result.ok && pack.prompts.length > 0) {
    process.stderr.write("\nTry:\n");
    for (const prompt of pack.prompts) {
      process.stderr.write(`  "${prompt}"\n`);
    }
  }

  if (!result.ok) {
    process.stderr.write("\nSome seed operations failed. Run with --verbose for details.\n");
    process.exit(1);
  }

  process.stderr.write("\n");
}

// ---------------------------------------------------------------------------
// koi demo list
// ---------------------------------------------------------------------------

async function runDemoList(): Promise<void> {
  const { listPacks } = await import("@koi/demo-packs");

  const packs = listPacks();

  process.stdout.write("Available demo packs:\n\n");
  for (const pack of packs) {
    process.stdout.write(`  ${pack.id.padEnd(12)} ${pack.description}\n`);
    if (pack.requires.length > 0) {
      process.stdout.write(`${"".padEnd(15)}requires: ${pack.requires.join(", ")}\n`);
    }
  }
  process.stdout.write("\n");
  process.stdout.write("Usage: koi demo init <pack>\n");
}

// ---------------------------------------------------------------------------
// koi demo reset
// ---------------------------------------------------------------------------

async function runDemoReset(flags: DemoFlags): Promise<void> {
  const packId = flags.pack;
  if (packId === undefined) {
    process.stderr.write("Usage: koi demo reset <pack>\n");
    process.exit(1);
  }

  const { getPack } = await import("@koi/demo-packs");
  const pack = getPack(packId);
  if (pack === undefined) {
    const { PACK_IDS } = await import("@koi/demo-packs");
    process.stderr.write(`Unknown demo pack: "${packId}". Available: ${PACK_IDS.join(", ")}\n`);
    process.exit(1);
  }

  // Load manifest for agent name
  const manifestPath = flags.manifest ?? "koi.yaml";
  const loadResult = await loadManifest(manifestPath);
  if (!loadResult.ok) {
    process.stderr.write(`Failed to load manifest: ${loadResult.error.message}\n`);
    process.exit(EXIT_CONFIG);
  }

  const { manifest } = loadResult.value;

  // Delete seeded data from Nexus
  const { createNexusClient } = await import("@koi/nexus-client");
  const { deleteJson } = await import("@koi/nexus-client");
  const nexusUrl = process.env.NEXUS_URL ?? "http://127.0.0.1:2026";
  const nexusClient = createNexusClient({
    baseUrl: nexusUrl,
    ...(process.env.NEXUS_API_KEY !== undefined ? { apiKey: process.env.NEXUS_API_KEY } : {}),
  });

  process.stderr.write(`Resetting demo pack "${packId}" for agent "${manifest.name}"...\n`);

  try {
    // Delete the agent's memory and corpus namespaces
    await deleteJson(nexusClient, `/agents/${manifest.name}/memory`);
    await deleteJson(nexusClient, `/agents/${manifest.name}/corpus`);
    process.stderr.write("  \u2713 Seeded data cleared\n\n");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`  Failed to clear data: ${message}\n`);
    process.stderr.write("  (Nexus may not be running — start it with `koi up` first)\n\n");
    process.exit(1);
  }
}
