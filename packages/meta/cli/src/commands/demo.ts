/**
 * `koi demo` subcommand — manage demo data.
 *
 * Subcommands:
 * - `koi demo init [pack]` — seed demo data
 * - `koi demo list` — list available demo packs
 * - `koi demo reset [pack]` — clear seeded data
 */

import { dirname, resolve } from "node:path";
import type { DemoFlags } from "../args.js";
import { createNexusClientFromEnv } from "../create-nexus-client-from-env.js";
import { loadManifestOrExit } from "../load-manifest-or-exit.js";

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
// Shared: resolve Nexus URL from manifest → env → default
// ---------------------------------------------------------------------------

interface ManifestWithNexus {
  readonly name: string;
  readonly nexus?: { readonly url?: string | undefined } | undefined;
}

function resolveNexusUrl(manifest: ManifestWithNexus): string {
  return manifest.nexus?.url ?? process.env.NEXUS_URL ?? "http://127.0.0.1:2026";
}

// ---------------------------------------------------------------------------
// koi demo init
// ---------------------------------------------------------------------------

async function runDemoInit(flags: DemoFlags): Promise<void> {
  const packId = flags.pack ?? "connected";

  const { getPack, runSeed } = await import("@koi/demo-packs");

  const pack = getPack(packId);
  if (pack === undefined) {
    const { PACK_IDS } = await import("@koi/demo-packs");
    process.stderr.write(`Unknown demo pack: "${packId}". Available: ${PACK_IDS.join(", ")}\n`);
    process.exit(1);
  }

  const manifestPath = flags.manifest ?? "koi.yaml";
  const { manifest } = await loadManifestOrExit(manifestPath);
  const workspaceRoot = resolve(dirname(manifestPath));

  const nexusUrl = resolveNexusUrl(manifest);
  const nexusClient = createNexusClientFromEnv(nexusUrl);

  process.stderr.write(`Seeding demo: ${pack.name}...\n`);

  const result = await runSeed(packId, {
    nexusClient,
    agentName: manifest.name,
    workspaceRoot,
    verbose: flags.verbose,
  });

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

  const manifestPath = flags.manifest ?? "koi.yaml";
  const { manifest } = await loadManifestOrExit(manifestPath);
  const workspaceRoot = resolve(dirname(manifestPath));

  const { deleteJson } = await import("@koi/nexus-client");
  const nexusUrl = resolveNexusUrl(manifest);
  const nexusClient = createNexusClientFromEnv(nexusUrl);

  process.stderr.write(`Resetting demo pack "${packId}" for agent "${manifest.name}"...\n`);

  const [memResult, corpusResult, dsDataResult, dsDescResult] = await Promise.all([
    deleteJson(nexusClient, `/agents/${manifest.name}/memory`),
    deleteJson(nexusClient, `/agents/${manifest.name}/corpus`),
    deleteJson(nexusClient, `/agents/${manifest.name}/datasources`),
    deleteJson(nexusClient, `/agents/${manifest.name}/workspace/datasources`),
  ]);

  if (!memResult.ok || !corpusResult.ok || !dsDataResult.ok || !dsDescResult.ok) {
    const errors: string[] = [];
    if (!memResult.ok) errors.push(`memory: ${memResult.error.message}`);
    if (!corpusResult.ok) errors.push(`corpus: ${corpusResult.error.message}`);
    if (!dsDataResult.ok) errors.push(`datasources: ${dsDataResult.error.message}`);
    if (!dsDescResult.ok) errors.push(`workspace/datasources: ${dsDescResult.error.message}`);
    process.stderr.write(`  Failed to clear data: ${errors.join("; ")}\n`);
    process.stderr.write("  (Nexus may not be running — start it with `koi up` first)\n\n");
    process.exit(1);
  }

  // Remove .demo-seeded marker so auto-seeding can re-run
  try {
    const { join } = await import("node:path");
    const { unlink } = await import("node:fs/promises");
    await unlink(join(workspaceRoot, ".koi", ".demo-seeded"));
  } catch {
    // Marker may not exist — that's fine
  }

  process.stderr.write("  \u2713 Seeded data cleared\n\n");
}
