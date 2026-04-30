/**
 * Decide whether to activate `@koi/middleware-ace` from a parsed
 * `manifest.ace` block. The host (tui-command.ts) calls this immediately
 * after the manifest loads, then writes the returned `message` to
 * stderr and threads `config` (when present) into createKoiRuntime.
 *
 * Three gates apply, evaluated in order:
 *   1. `manifest.ace.enabled !== true` → kind: "skip" (silent)
 *   2. `manifest.stacks` is undefined OR includes "spawn" → kind:
 *      "spawn-blocked" (the spawn preset stack would let child agents
 *      inherit and contaminate the in-memory PlaybookStore)
 *   3. otherwise → kind: "activate" with an in-memory AceConfig
 *
 * Resume-provenance is gated outside this function: when `koi tui
 * --resume` is invoked without `--manifest`, the host skips manifest
 * discovery entirely so this function is never called.
 *
 * See docs/superpowers/specs/2026-04-30-tui-ace-toml-design.md round 10.
 */

import type { AceConfig } from "@koi/middleware-ace";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "@koi/middleware-ace";

import type { ManifestAceConfig } from "./manifest.js";

export type AceActivationResult =
  | { readonly kind: "skip" }
  | { readonly kind: "spawn-blocked"; readonly message: string }
  | { readonly kind: "activate"; readonly config: AceConfig; readonly message: string };

/** Override the in-memory store factories. Tests pass deterministic stubs. */
export interface AceStoreFactories {
  readonly playbookStore: () => AceConfig["playbookStore"];
  readonly trajectoryStore: () => NonNullable<AceConfig["trajectoryStore"]>;
}

const DEFAULT_FACTORIES: AceStoreFactories = {
  playbookStore: createInMemoryPlaybookStore,
  trajectoryStore: createInMemoryTrajectoryStore,
};

const SPAWN_BLOCKED_MESSAGE =
  "koi tui: ace: refusing to activate while the spawn preset stack is active. " +
  "Set manifest.stacks to a list that excludes 'spawn' " +
  '(e.g., ["observability", "checkpoint", "execution"]) to dogfood ACE. ' +
  "Continuing without ACE.\n";

const ACTIVATED_MESSAGE =
  "koi tui: ace: enabled (in-memory; lost on process exit; survives /clear and /new)\n";

export function resolveAceActivation(
  manifestAce: ManifestAceConfig | undefined,
  manifestStacks: readonly string[] | undefined,
  factories: AceStoreFactories = DEFAULT_FACTORIES,
): AceActivationResult {
  if (manifestAce?.enabled !== true) return { kind: "skip" };
  const spawnActive = manifestStacks === undefined || manifestStacks.includes("spawn");
  if (spawnActive) return { kind: "spawn-blocked", message: SPAWN_BLOCKED_MESSAGE };
  return {
    kind: "activate",
    config: {
      playbookStore: factories.playbookStore(),
      trajectoryStore: factories.trajectoryStore(),
      ...(manifestAce.maxInjectedTokens !== undefined
        ? { maxInjectedTokens: manifestAce.maxInjectedTokens }
        : {}),
      ...(manifestAce.minScore !== undefined ? { minScore: manifestAce.minScore } : {}),
      ...(manifestAce.lambda !== undefined ? { lambda: manifestAce.lambda } : {}),
    },
    message: ACTIVATED_MESSAGE,
  };
}
