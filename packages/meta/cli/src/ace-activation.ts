/**
 * Decide whether to activate `@koi/middleware-ace` from a parsed
 * `manifest.ace` block. The host (tui-command.ts) calls this immediately
 * after the manifest loads, then writes the returned `message` to
 * stderr and threads `config` (when present) into createKoiRuntime.
 *
 * Two outcomes:
 *   1. `manifest.ace.enabled !== true` → kind: "skip" (silent)
 *   2. otherwise → kind: "activate" with an in-memory AceConfig
 *
 * Spawn isolation is provided by the runtime, not this function:
 * `inheritedMiddlewareForChildren` in `runtime-factory.ts` deliberately
 * excludes ACE, so spawned children never see ACE injection or recording.
 * The parent's `PlaybookStore` is unreachable from the child path; the
 * spawn preset stack and ACE coexist safely.
 *
 * Resume-provenance is gated outside this function: when `koi tui
 * --resume` is invoked without `--manifest`, the host skips manifest
 * discovery entirely so this function is never called. The double opt-in
 * (`enabled` + `acknowledge_cross_session_state`) makes the
 * /clear- and /new-survival behavior explicit at manifest load.
 *
 * See docs/superpowers/specs/2026-04-30-tui-ace-toml-design.md.
 */

import type { AceConfig } from "@koi/middleware-ace";
import { createInMemoryPlaybookStore } from "@koi/middleware-ace";

import type { ManifestAceConfig } from "./manifest.js";

export type AceActivationResult =
  | { readonly kind: "skip" }
  | { readonly kind: "activate"; readonly config: AceConfig; readonly message: string };

/** Override the in-memory store factory. Tests pass a deterministic stub. */
export interface AceStoreFactories {
  readonly playbookStore: () => AceConfig["playbookStore"];
}

const DEFAULT_FACTORIES: AceStoreFactories = {
  playbookStore: createInMemoryPlaybookStore,
};

const ACTIVATED_MESSAGE =
  "koi tui: ace: enabled (in-memory). Learned playbooks persist across " +
  "/clear and /new within this process; they are lost on process exit. " +
  "Restart the TUI for a privacy boundary.\n";

export function resolveAceActivation(
  manifestAce: ManifestAceConfig | undefined,
  factories: AceStoreFactories = DEFAULT_FACTORIES,
): AceActivationResult {
  if (manifestAce?.enabled !== true) return { kind: "skip" };
  // Intentionally omit `trajectoryStore`: the in-memory store grows
  // unboundedly across sessions with no pruning hook today, and ACE
  // consolidates trajectories at `onSessionEnd` even without a persistent
  // store (per AceConfig docs). Persistent trajectory storage lands with
  // @koi/playbook-store-sqlite (#2087).
  return {
    kind: "activate",
    config: {
      playbookStore: factories.playbookStore(),
      ...(manifestAce.maxInjectedTokens !== undefined
        ? { maxInjectedTokens: manifestAce.maxInjectedTokens }
        : {}),
      ...(manifestAce.minScore !== undefined ? { minScore: manifestAce.minScore } : {}),
      ...(manifestAce.lambda !== undefined ? { lambda: manifestAce.lambda } : {}),
    },
    message: ACTIVATED_MESSAGE,
  };
}
