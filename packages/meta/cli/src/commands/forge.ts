/**
 * `koi forge` subcommand — manage community bricks.
 *
 * Subcommands:
 * - `koi forge install <name>`   Fetch from remote registry, verify, save locally
 * - `koi forge publish <brick-id>` Publish a local brick to the community registry
 * - `koi forge search <query>`   Search the remote registry
 * - `koi forge inspect <name>`   Display brick metadata + provenance
 * - `koi forge update --all`     Batch-check and update changed bricks
 * - `koi forge uninstall <name>` Remove a brick from local store
 */

import type { ForgeFlags } from "../args.js";

export async function runForge(flags: ForgeFlags): Promise<void> {
  switch (flags.subcommand) {
    case "install":
      await runForgeInstall(flags);
      break;
    case "publish":
      await runForgePublish(flags);
      break;
    case "search":
      await runForgeSearch(flags);
      break;
    case "inspect":
      await runForgeInspect(flags);
      break;
    case "update":
      await runForgeUpdate(flags);
      break;
    case "uninstall":
      await runForgeUninstall(flags);
      break;
    default:
      process.stderr.write("Usage:\n");
      process.stderr.write("  koi forge install <name>       Install a brick from the registry\n");
      process.stderr.write("  koi forge publish <brick-id>   Publish a brick to the registry\n");
      process.stderr.write("  koi forge search <query>       Search the remote registry\n");
      process.stderr.write("  koi forge inspect <name>       Inspect brick metadata\n");
      process.stderr.write(
        "  koi forge update --all         Update all installed community bricks\n",
      );
      process.stderr.write("  koi forge uninstall <name>     Remove a brick from local store\n");
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Shared: resolve registry URL from flags → env → default
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRY_URL = "https://registry.koi.dev";

function resolveRegistryUrl(flags: ForgeFlags): string {
  return flags.registry ?? process.env.KOI_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
}

// ---------------------------------------------------------------------------
// koi forge install <name>
// ---------------------------------------------------------------------------

async function runForgeInstall(flags: ForgeFlags): Promise<void> {
  const name = flags.name;
  if (name === undefined) {
    process.stderr.write("Usage: koi forge install <name>\n");
    process.exit(1);
  }

  const registryUrl = resolveRegistryUrl(flags);
  process.stderr.write(`Fetching "${name}" from ${registryUrl}...\n`);

  const { createRemoteRegistry } = await import("@koi/registry-remote");
  const registry = createRemoteRegistry({ baseUrl: registryUrl });

  const kind = (flags.kind ?? "tool") as
    | "tool"
    | "skill"
    | "agent"
    | "middleware"
    | "channel"
    | "composite";
  const result = await registry.get(kind, name, flags.namespace);
  if (!result.ok) {
    process.stderr.write(`Failed to fetch brick "${name}": ${result.error.message}\n`);
    process.exit(1);
  }

  const brick = result.value;

  // Verify integrity
  process.stderr.write("  Verifying integrity...\n");
  const { verifyBrickIntegrity } = await import("@koi/forge-integrity");
  const integrityResult = verifyBrickIntegrity(brick);
  if (integrityResult.kind !== "ok") {
    process.stderr.write(`  Integrity check failed: ${integrityResult.kind}\n`);
    if (!flags.yes) {
      process.stderr.write("  Use --yes to install anyway (not recommended).\n");
      process.exit(1);
    }
    process.stderr.write("  Proceeding despite integrity failure (--yes).\n");
  }

  // Check dependencies — uses local in-memory store as placeholder
  process.stderr.write("  Checking dependencies...\n");
  const { checkBrickDependencies } = await import("@koi/registry-remote");
  const { createInMemoryForgeStore } = await import("@koi/forge-tools");
  const localStore = createInMemoryForgeStore();
  const depResult = await checkBrickDependencies(brick, localStore, registry);

  if (!depResult.satisfied) {
    process.stderr.write("  Missing dependencies:\n");
    for (const dep of depResult.missing) {
      const remote = dep.availableRemotely ? " (available in registry)" : "";
      process.stderr.write(`    - [${dep.kind}] ${dep.name}${remote}\n`);
    }
    if (!flags.yes) {
      process.stderr.write("  Use --yes to install anyway.\n");
      process.exit(1);
    }
  }

  // Save to local store — the existing pipeline (discovery → ECS → tools/system prompt)
  // picks up new bricks automatically via ForgeStore.save()
  const saveResult = await localStore.save(brick);
  if (!saveResult.ok) {
    process.stderr.write(`  Failed to save brick: ${saveResult.error.message}\n`);
    process.exit(1);
  }

  process.stderr.write(`  Installed "${brick.name}" (${brick.kind}) [${brick.id}]\n\n`);
}

// ---------------------------------------------------------------------------
// koi forge publish <brick-id>
// ---------------------------------------------------------------------------

async function runForgePublish(flags: ForgeFlags): Promise<void> {
  const brickIdStr = flags.name;
  if (brickIdStr === undefined) {
    process.stderr.write("Usage: koi forge publish <brick-id>\n");
    process.exit(1);
  }

  const authToken = process.env.KOI_REGISTRY_TOKEN;
  if (authToken === undefined) {
    process.stderr.write("Set KOI_REGISTRY_TOKEN environment variable to publish.\n");
    process.exit(1);
  }

  process.stderr.write(`Loading brick "${brickIdStr}" from local store...\n`);

  const { createInMemoryForgeStore } = await import("@koi/forge-tools");
  const store = createInMemoryForgeStore();
  const { brickId } = await import("@koi/core");
  const loadResult = await store.load(brickId(brickIdStr));
  if (!loadResult.ok) {
    process.stderr.write(`  Failed to load brick: ${loadResult.error.message}\n`);
    process.exit(1);
  }

  const brick = loadResult.value;
  const registryUrl = resolveRegistryUrl(flags);
  process.stderr.write(`Publishing "${brick.name}" to ${registryUrl}...\n`);

  const { publishBrick } = await import("@koi/registry-remote");
  const publishResult = await publishBrick(brick, {
    registryUrl,
    authToken,
  });
  if (!publishResult.ok) {
    process.stderr.write(`  Publish failed: ${publishResult.error.message}\n`);
    process.exit(1);
  }

  process.stderr.write(
    `  Published "${brick.name}" (${brick.kind}) → ${publishResult.value.url}\n\n`,
  );
}

// ---------------------------------------------------------------------------
// koi forge search <query>
// ---------------------------------------------------------------------------

async function runForgeSearch(flags: ForgeFlags): Promise<void> {
  const query = flags.name;
  if (query === undefined) {
    process.stderr.write("Usage: koi forge search <query>\n");
    process.exit(1);
  }

  const registryUrl = resolveRegistryUrl(flags);

  const { createRemoteRegistry } = await import("@koi/registry-remote");
  const registry = createRemoteRegistry({ baseUrl: registryUrl });

  const searchQuery: import("@koi/core").BrickSearchQuery = {
    text: query,
    ...(flags.kind !== undefined
      ? { kind: flags.kind as "tool" | "skill" | "agent" | "middleware" | "channel" | "composite" }
      : {}),
    ...(flags.tags !== undefined ? { tags: flags.tags.split(",") } : {}),
    ...(flags.namespace !== undefined ? { namespace: flags.namespace } : {}),
  };
  const page = await registry.search(searchQuery);

  if (page.items.length === 0) {
    process.stdout.write(`No bricks found for "${query}".\n`);
    return;
  }

  // Table header
  const nameCol = 24;
  const kindCol = 12;
  const versionCol = 10;
  process.stdout.write(
    `${"NAME".padEnd(nameCol)} ${"KIND".padEnd(kindCol)} ${"VERSION".padEnd(versionCol)} DESCRIPTION\n`,
  );
  process.stdout.write(
    `${"-".repeat(nameCol)} ${"-".repeat(kindCol)} ${"-".repeat(versionCol)} ${"-".repeat(40)}\n`,
  );

  for (const brick of page.items) {
    const ns = brick.namespace !== undefined ? `${brick.namespace}/` : "";
    const displayName = `${ns}${brick.name}`;
    process.stdout.write(
      `${displayName.padEnd(nameCol)} ${brick.kind.padEnd(kindCol)} ${brick.version.padEnd(versionCol)} ${brick.description}\n`,
    );
  }

  if (page.total !== undefined) {
    process.stdout.write(`\n${page.items.length} of ${page.total} results shown.\n`);
  }

  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// koi forge inspect <name>
// ---------------------------------------------------------------------------

async function runForgeInspect(flags: ForgeFlags): Promise<void> {
  const name = flags.name;
  if (name === undefined) {
    process.stderr.write("Usage: koi forge inspect <name>\n");
    process.exit(1);
  }

  const registryUrl = resolveRegistryUrl(flags);

  const { createRemoteRegistry } = await import("@koi/registry-remote");
  const registry = createRemoteRegistry({ baseUrl: registryUrl });

  const kind = (flags.kind ?? "tool") as
    | "tool"
    | "skill"
    | "agent"
    | "middleware"
    | "channel"
    | "composite";
  const result = await registry.get(kind, name, flags.namespace);
  if (!result.ok) {
    process.stderr.write(`Brick "${name}" not found: ${result.error.message}\n`);
    process.exit(1);
  }

  const brick = result.value;

  process.stdout.write(`Name:        ${brick.name}\n`);
  process.stdout.write(`Kind:        ${brick.kind}\n`);
  process.stdout.write(`ID:          ${brick.id}\n`);
  process.stdout.write(`Version:     ${brick.version}\n`);
  process.stdout.write(`Scope:       ${brick.scope}\n`);
  process.stdout.write(`Lifecycle:   ${brick.lifecycle}\n`);
  process.stdout.write(`Description: ${brick.description}\n`);

  if (brick.namespace !== undefined) {
    process.stdout.write(`Namespace:   ${brick.namespace}\n`);
  }

  if (brick.tags.length > 0) {
    process.stdout.write(`Tags:        ${brick.tags.join(", ")}\n`);
  }

  // Provenance
  process.stdout.write("\nProvenance:\n");
  process.stdout.write(`  Agent:       ${brick.provenance.metadata.agentId}\n`);
  process.stdout.write(`  Invocation:  ${brick.provenance.metadata.invocationId}\n`);
  process.stdout.write(
    `  Started:     ${new Date(brick.provenance.metadata.startedAt).toISOString()}\n`,
  );
  process.stdout.write(
    `  Finished:    ${new Date(brick.provenance.metadata.finishedAt).toISOString()}\n`,
  );
  process.stdout.write(`  Verified:    ${brick.provenance.verification.passed ? "yes" : "no"}\n`);
  process.stdout.write(`  Sandboxed:   ${String(brick.provenance.verification.sandbox)}\n`);

  // Requirements
  if (brick.requires !== undefined) {
    process.stdout.write("\nRequires:\n");
    if (brick.requires.bins !== undefined && brick.requires.bins.length > 0) {
      process.stdout.write(`  Bins:        ${brick.requires.bins.join(", ")}\n`);
    }
    if (brick.requires.env !== undefined && brick.requires.env.length > 0) {
      process.stdout.write(`  Env:         ${brick.requires.env.join(", ")}\n`);
    }
    if (brick.requires.tools !== undefined && brick.requires.tools.length > 0) {
      process.stdout.write(`  Tools:       ${brick.requires.tools.join(", ")}\n`);
    }
    if (brick.requires.agents !== undefined && brick.requires.agents.length > 0) {
      process.stdout.write(`  Agents:      ${brick.requires.agents.join(", ")}\n`);
    }
    if (brick.requires.network === true) {
      process.stdout.write("  Network:     yes\n");
    }
    if (brick.requires.platform !== undefined && brick.requires.platform.length > 0) {
      process.stdout.write(`  Platform:    ${brick.requires.platform.join(", ")}\n`);
    }
  }

  // Security / integrity
  process.stdout.write("\nSecurity:\n");
  process.stdout.write(`  Origin:      ${brick.origin}\n`);
  process.stdout.write(`  Sandbox:     ${String(brick.policy.sandbox)}\n`);
  if (brick.lastVerifiedAt !== undefined) {
    process.stdout.write(`  Verified:    ${new Date(brick.lastVerifiedAt).toISOString()}\n`);
  }
  process.stdout.write(`  Content Hash: ${brick.provenance.contentHash}\n`);

  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// koi forge update --all
// ---------------------------------------------------------------------------

async function runForgeUpdate(flags: ForgeFlags): Promise<void> {
  if (!flags.all) {
    process.stderr.write("Usage: koi forge update --all\n");
    process.stderr.write("  Batch-check and update all installed community bricks.\n");
    process.exit(1);
  }

  process.stderr.write("Checking for updates...\n");

  const { createInMemoryForgeStore } = await import("@koi/forge-tools");
  const store = createInMemoryForgeStore();

  // List all installed community bricks (those with namespace set)
  const searchResult = await store.search({});
  if (!searchResult.ok) {
    process.stderr.write(`  Failed to list installed bricks: ${searchResult.error.message}\n`);
    process.exit(1);
  }

  const installed = searchResult.value.filter((b) => b.namespace !== undefined);
  if (installed.length === 0) {
    process.stdout.write("No community bricks installed.\n");
    return;
  }

  const registryUrl = resolveRegistryUrl(flags);
  const hashes = installed.map((b) => b.provenance.contentHash);

  const { createRemoteRegistry } = await import("@koi/registry-remote");
  const registry = createRemoteRegistry({ baseUrl: registryUrl });
  const checkResult = await registry.batchCheck(hashes);

  if (!checkResult.ok) {
    process.stderr.write(`  Batch check failed: ${checkResult.error.message}\n`);
    process.exit(1);
  }

  // Find bricks whose hash is in the "missing" set — they have newer versions
  const missingSet = new Set(checkResult.value.missing);
  const needsUpdate = installed.filter((b) => missingSet.has(b.provenance.contentHash));

  if (needsUpdate.length === 0) {
    process.stdout.write("All community bricks are up to date.\n\n");
    return;
  }

  process.stderr.write(`Found ${needsUpdate.length} brick(s) that may have updates:\n`);

  let updatedCount = 0;
  for (const brick of needsUpdate) {
    process.stderr.write(`  Updating "${brick.name}"...\n`);
    const getResult = await registry.get(brick.kind, brick.name, brick.namespace);
    if (!getResult.ok) {
      process.stderr.write(`    Failed: ${getResult.error.message}\n`);
      continue;
    }

    const saveResult = await store.save(getResult.value);
    if (!saveResult.ok) {
      process.stderr.write(`    Failed to save: ${saveResult.error.message}\n`);
      continue;
    }

    updatedCount += 1;
    process.stderr.write(`    Updated to ${getResult.value.id}\n`);
  }

  process.stderr.write(`\n${updatedCount} brick(s) updated.\n\n`);
}

// ---------------------------------------------------------------------------
// koi forge uninstall <name>
// ---------------------------------------------------------------------------

async function runForgeUninstall(flags: ForgeFlags): Promise<void> {
  const name = flags.name;
  if (name === undefined) {
    process.stderr.write("Usage: koi forge uninstall <name>\n");
    process.exit(1);
  }

  process.stderr.write(`Removing "${name}" from local store...\n`);

  const { createInMemoryForgeStore } = await import("@koi/forge-tools");
  const store = createInMemoryForgeStore();

  // Find the brick by name first
  const searchResult = await store.search({ text: name, limit: 1 });
  if (!searchResult.ok) {
    process.stderr.write(`  Search failed: ${searchResult.error.message}\n`);
    process.exit(1);
  }

  const found = searchResult.value[0];
  if (found === undefined) {
    process.stderr.write(`  Brick "${name}" not found in local store.\n`);
    process.exit(1);
  }

  const removeResult = await store.remove(found.id);
  if (!removeResult.ok) {
    process.stderr.write(`  Failed to remove: ${removeResult.error.message}\n`);
    process.exit(1);
  }

  process.stderr.write(`  Removed "${found.name}" (${found.kind}) [${found.id}]\n\n`);
}
