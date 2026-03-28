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

import { EXIT_CONFIG, EXIT_ERROR, EXIT_NETWORK } from "@koi/shutdown";
import type { ForgeFlags } from "../args.js";
import { expectArg } from "../expect-arg.js";

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
      process.exit(EXIT_CONFIG);
  }
}

// ---------------------------------------------------------------------------
// Shared: resolve registry URL / Nexus URL from flags → env → default
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRY_URL = "https://registry.koi.dev";
const DEFAULT_NEXUS_URL = "http://127.0.0.1:2026";

function resolveRegistryUrl(flags: ForgeFlags): string {
  return flags.registry ?? process.env.KOI_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
}

function resolveNexusUrl(manifest: {
  readonly nexus?: { readonly url?: string | undefined } | undefined;
}): string {
  return manifest.nexus?.url ?? process.env.NEXUS_URL ?? DEFAULT_NEXUS_URL;
}

/**
 * Create a persistent Nexus-backed ForgeStore from the manifest.
 *
 * This ensures bricks persist across CLI invocations. Falls back to
 * the manifest's Nexus URL → NEXUS_URL env → localhost:2026.
 */
async function resolveLocalStore(manifestPath: string): Promise<import("@koi/core").ForgeStore> {
  const { loadManifestOrExit } = await import("../load-manifest-or-exit.js");
  const { manifest } = await loadManifestOrExit(manifestPath);
  const nexusUrl = resolveNexusUrl(manifest);
  const { createNexusForgeStore } = await import("@koi/nexus-store");
  return createNexusForgeStore({
    baseUrl: nexusUrl,
    apiKey: process.env.NEXUS_API_KEY ?? "",
    basePath: `agents/${manifest.name}/forge`,
  });
}

// ---------------------------------------------------------------------------
// koi forge install <name>
// ---------------------------------------------------------------------------

async function runForgeInstall(flags: ForgeFlags): Promise<void> {
  const name = expectArg(flags.name, "name", "koi forge install <name>");

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
    process.exit(EXIT_NETWORK);
  }

  const brick = result.value;

  // Verify content-hash integrity
  process.stderr.write("  Verifying integrity...\n");
  const { verifyBrickAttestation, verifyBrickIntegrity } = await import("@koi/forge-integrity");
  const integrityResult = verifyBrickIntegrity(brick);
  if (integrityResult.kind !== "ok") {
    process.stderr.write(`  Content hash mismatch: ${integrityResult.kind}\n`);
    if (!flags.yes) {
      process.stderr.write("  Use --yes to install anyway (not recommended).\n");
      process.exit(EXIT_ERROR);
    }
    process.stderr.write("  Proceeding despite integrity failure (--yes).\n");
  }

  // Verify attestation signature (when brick has one)
  if (brick.provenance.attestation !== undefined) {
    process.stderr.write("  Verifying attestation signature...\n");
    // Use HMAC-SHA256 signer for community registry attestations
    const secret = process.env.KOI_REGISTRY_SIGNING_KEY ?? "koi-community-v1";
    const signer: import("@koi/core").SigningBackend = {
      algorithm: "hmac-sha256",
      sign(data: Uint8Array): Uint8Array {
        const hasher = new Bun.CryptoHasher("sha256", secret);
        hasher.update(data);
        return new Uint8Array(hasher.digest());
      },
      verify(data: Uint8Array, signature: Uint8Array): boolean {
        const hasher = new Bun.CryptoHasher("sha256", secret);
        hasher.update(data);
        const expected = new Uint8Array(hasher.digest());
        if (expected.length !== signature.length) return false;
        for (let i = 0; i < expected.length; i++) {
          if (expected[i] !== signature[i]) return false;
        }
        return true;
      },
    };
    const attestResult = await verifyBrickAttestation(brick, signer);
    if (attestResult.kind === "attestation_failed") {
      process.stderr.write(`  Attestation verification failed: ${attestResult.reason}\n`);
      if (!flags.yes) {
        process.stderr.write("  Use --yes to install anyway (not recommended).\n");
        process.exit(EXIT_ERROR);
      }
      process.stderr.write("  Proceeding despite attestation failure (--yes).\n");
    }
  }

  // Verify Ed25519 brick signature and classify trust tier
  const { classifyTrustTier } = await import("@koi/forge-integrity");
  const registryTrustedKeysEnv = process.env.KOI_REGISTRY_TRUSTED_KEYS ?? "";
  const trustedKeys = new Set(
    registryTrustedKeysEnv.length > 0 ? registryTrustedKeysEnv.split(",") : [],
  );

  const trustTier = classifyTrustTier(
    brick.signature,
    { contentHash: brick.provenance.contentHash, kind: brick.kind, name: brick.name },
    trustedKeys,
  );
  process.stderr.write(`  Trust tier: ${trustTier}\n`);

  // Require confirmation for "community" tier, block "local" without --yes
  if (trustTier === "local" && !flags.yes) {
    process.stderr.write("  Brick is unsigned (local trust). Use --yes to install anyway.\n");
    process.exit(EXIT_ERROR);
  }
  if (trustTier === "community" && !flags.yes) {
    process.stderr.write(
      "  Brick is signed by an unverified author. Use --yes to accept community trust.\n",
    );
    process.exit(EXIT_ERROR);
  }

  // Check dependencies against the local store
  const manifestPath = flags.manifest ?? "koi.yaml";
  const store = await resolveLocalStore(manifestPath);

  process.stderr.write("  Checking dependencies...\n");
  const { checkBrickDependencies } = await import("@koi/registry-remote");
  const depResult = await checkBrickDependencies(brick, store, registry);

  if (!depResult.satisfied) {
    process.stderr.write("  Missing dependencies:\n");
    for (const dep of depResult.missing) {
      const remote = dep.availableRemotely ? " (available in registry)" : "";
      process.stderr.write(`    - [${dep.kind}] ${dep.name}${remote}\n`);
    }
    if (!flags.yes) {
      process.stderr.write("  Use --yes to install anyway.\n");
      process.exit(EXIT_ERROR);
    }
  }

  // Save to local store — the existing pipeline (discovery → ECS → tools/system prompt)
  // picks up new bricks automatically via ForgeStore.save()
  const saveResult = await store.save(brick);
  if (!saveResult.ok) {
    process.stderr.write(`  Failed to save brick: ${saveResult.error.message}\n`);
    process.exit(EXIT_ERROR);
  }

  process.stderr.write(`  Installed "${brick.name}" (${brick.kind}) [${brick.id}]\n\n`);
}

// ---------------------------------------------------------------------------
// koi forge publish <brick-id>
// ---------------------------------------------------------------------------

async function runForgePublish(flags: ForgeFlags): Promise<void> {
  const brickIdStr = expectArg(flags.name, "brick-id", "koi forge publish <brick-id>");

  const authToken = process.env.KOI_REGISTRY_TOKEN;
  if (authToken === undefined) {
    process.stderr.write("Set KOI_REGISTRY_TOKEN environment variable to publish.\n");
    process.exit(EXIT_CONFIG);
  }

  process.stderr.write(`Loading brick "${brickIdStr}" from local store...\n`);

  const manifestPath = flags.manifest ?? "koi.yaml";
  const store = await resolveLocalStore(manifestPath);
  const { brickId } = await import("@koi/core");
  const loadResult = await store.load(brickId(brickIdStr));
  if (!loadResult.ok) {
    process.stderr.write(`  Failed to load brick: ${loadResult.error.message}\n`);
    process.exit(EXIT_ERROR);
  }

  const brick = loadResult.value;
  const registryUrl = resolveRegistryUrl(flags);
  process.stderr.write(`Publishing "${brick.name}" to ${registryUrl}...\n`);

  const { publishBrick } = await import("@koi/registry-remote");
  const { verifyBrickIntegrity } = await import("@koi/forge-integrity");
  const publishResult = await publishBrick(brick, {
    registryUrl,
    authToken,
    verifyIntegrity: (b) => {
      const r = verifyBrickIntegrity(b);
      return { ok: r.ok, kind: r.kind };
    },
  });
  if (!publishResult.ok) {
    process.stderr.write(`  Publish failed: ${publishResult.error.message}\n`);
    process.exit(EXIT_NETWORK);
  }

  const pv = publishResult.value;
  process.stderr.write(`  Published "${pv.name}" (${pv.kind}) [${pv.id}]\n\n`);
}

// ---------------------------------------------------------------------------
// koi forge search <query>
// ---------------------------------------------------------------------------

async function runForgeSearch(flags: ForgeFlags): Promise<void> {
  const query = expectArg(flags.name, "query", "koi forge search <query>");

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
  const name = expectArg(flags.name, "name", "koi forge inspect <name>");

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
    process.exit(EXIT_NETWORK);
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
  if (brick.trustTier !== undefined) {
    process.stdout.write(`  Trust Tier:  ${brick.trustTier}\n`);
  }
  if (brick.signature !== undefined) {
    process.stdout.write(`  Signed:      ${new Date(brick.signature.signedAt).toISOString()}\n`);
    process.stdout.write(`  Algorithm:   ${brick.signature.algorithm}\n`);
  }
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
    process.exit(EXIT_CONFIG);
  }

  process.stderr.write("Checking for updates...\n");

  const manifestPath = flags.manifest ?? "koi.yaml";
  const store = await resolveLocalStore(manifestPath);

  // List all installed community bricks (those with namespace set)
  const searchResult = await store.search({});
  if (!searchResult.ok) {
    process.stderr.write(`  Failed to list installed bricks: ${searchResult.error.message}\n`);
    process.exit(EXIT_ERROR);
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
    process.exit(EXIT_NETWORK);
  }

  // Hashes not found in the remote registry indicate bricks with newer versions
  const missingSet = new Set(checkResult.value.missing);
  const needsUpdate = installed.filter((b) => missingSet.has(b.provenance.contentHash));

  if (needsUpdate.length === 0) {
    process.stdout.write("All community bricks are up to date.\n\n");
    return;
  }

  process.stderr.write(`Found ${needsUpdate.length} brick(s) that may have updates:\n`);

  // Fetch updated bricks concurrently (up to 5 at a time)
  const UPDATE_CONCURRENCY = 5;
  const { mapWithConcurrency } = await import("@koi/errors");

  type UpdateOutcome =
    | { readonly status: "updated"; readonly name: string; readonly newId: string }
    | { readonly status: "failed"; readonly name: string; readonly reason: string };

  const outcomes = await mapWithConcurrency(
    needsUpdate,
    async (brick): Promise<UpdateOutcome> => {
      const getResult = await registry.get(brick.kind, brick.name, brick.namespace);
      if (!getResult.ok) {
        return { status: "failed", name: brick.name, reason: getResult.error.message };
      }

      const saveResult = await store.save(getResult.value);
      if (!saveResult.ok) {
        return { status: "failed", name: brick.name, reason: saveResult.error.message };
      }

      return { status: "updated", name: brick.name, newId: getResult.value.id };
    },
    UPDATE_CONCURRENCY,
  );

  let updatedCount = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "updated") {
      updatedCount += 1;
      process.stderr.write(`  Updated "${outcome.name}" → ${outcome.newId}\n`);
    } else {
      process.stderr.write(`  Failed "${outcome.name}": ${outcome.reason}\n`);
    }
  }

  process.stderr.write(`\n${updatedCount} brick(s) updated.\n\n`);
}

// ---------------------------------------------------------------------------
// koi forge uninstall <name>
// ---------------------------------------------------------------------------

async function runForgeUninstall(flags: ForgeFlags): Promise<void> {
  const name = expectArg(flags.name, "name", "koi forge uninstall <name>");

  process.stderr.write(`Removing "${name}" from local store...\n`);

  const manifestPath = flags.manifest ?? "koi.yaml";
  const store = await resolveLocalStore(manifestPath);

  // Exact match: search by kind + namespace, then filter by exact name
  const kind = (flags.kind ?? "tool") as
    | "tool"
    | "skill"
    | "agent"
    | "middleware"
    | "channel"
    | "composite";
  const query: import("@koi/core").ForgeQuery = {
    kind,
    ...(flags.namespace !== undefined ? { namespace: flags.namespace } : {}),
  };
  const searchResult = await store.search(query);
  if (!searchResult.ok) {
    process.stderr.write(`  Search failed: ${searchResult.error.message}\n`);
    process.exit(EXIT_ERROR);
  }

  // Filter to exact name match (not substring)
  const found = searchResult.value.find((b) => b.name === name);
  if (found === undefined) {
    process.stderr.write(`  Brick "${kind}:${name}" not found in local store.\n`);
    process.exit(EXIT_ERROR);
  }

  const removeResult = await store.remove(found.id);
  if (!removeResult.ok) {
    process.stderr.write(`  Failed to remove: ${removeResult.error.message}\n`);
    process.exit(EXIT_ERROR);
  }

  process.stderr.write(`  Removed "${found.name}" (${found.kind}) [${found.id}]\n\n`);
}
