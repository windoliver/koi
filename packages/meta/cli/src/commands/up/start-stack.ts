/**
 * Start-stack — runs koi startup in-process with progress callbacks.
 *
 * Phases 1-4 perform real validation (manifest, preset, preflight, agent resolve).
 * Phase 5 boots the runtime in-process via bootRuntime() and stores the handle
 * on context for the caller to manage lifecycle.
 */

import type {
  OperationResult,
  PhaseCallbacks,
  PhaseDefinition,
  SetupWizardState,
} from "@koi/setup-core";
import { runPhases } from "@koi/setup-core";
import type { RuntimeHandle } from "./boot-runtime.js";

/** Context passed through all startup phases. */
export interface StartStackContext {
  readonly wizardState: SetupWizardState;
  readonly manifestPath: string;
  readonly workspaceRoot: string;
  readonly verbose: boolean;
  readonly adminPort: number;
  readonly adminUrl: string;
  /** Set by the runtime phase — handle for lifecycle cleanup. Mutable by design. */
  runtimeHandle?: RuntimeHandle | undefined;
}

/**
 * Create phase definitions that call real orchestrator components.
 */
function createStartupPhases(): readonly PhaseDefinition<StartStackContext>[] {
  return [
    {
      id: "manifest",
      label: "Loading manifest",
      execute: async (ctx, onProgress) => {
        onProgress("Reading koi.yaml");
        const { loadManifest } = await import("@koi/manifest");
        const result = await loadManifest(ctx.manifestPath, undefined, {
          rejectUnsupportedHooks: true,
        });
        if (!result.ok) {
          throw new Error(`Failed to load manifest: ${result.error.message}`);
        }
        onProgress(`Loaded: ${result.value.manifest.name}`);
      },
    },
    {
      id: "preset",
      label: "Resolving preset",
      execute: async (ctx, onProgress) => {
        onProgress(`Preset: ${ctx.wizardState.preset}`);
        const { inferPresetId } = await import("./preset.js");
        const presetId = await inferPresetId(ctx.manifestPath);
        const { resolveRuntimePreset } = await import("@koi/runtime-presets");
        resolveRuntimePreset(presetId);
      },
    },
    {
      id: "preflight",
      label: "Running preflight checks",
      execute: async (ctx, onProgress) => {
        onProgress("Checking environment");
        const { loadManifest } = await import("@koi/manifest");
        const loadResult = await loadManifest(ctx.manifestPath, undefined, {
          rejectUnsupportedHooks: true,
        });
        if (!loadResult.ok) throw new Error("Manifest not loaded");
        const { createCliOutput } = await import("@koi/cli-render");
        const output = createCliOutput({ verbose: ctx.verbose });
        const { runPreflight } = await import("./preflight.js");
        const result = await runPreflight({
          manifest: loadResult.value.manifest,
          env: process.env,
          temporalRequired: false,
          output,
        });
        if (!result.passed) {
          throw new Error("Preflight checks failed — check environment variables and dependencies");
        }
      },
    },
    {
      id: "resolve",
      label: "Resolving agent definition",
      execute: async (ctx, onProgress) => {
        onProgress(`Agent: ${ctx.wizardState.name}`);
        const { loadManifest } = await import("@koi/manifest");
        const loadResult = await loadManifest(ctx.manifestPath, undefined, {
          rejectUnsupportedHooks: true,
        });
        if (!loadResult.ok) throw new Error("Manifest not loaded");
        const { resolveAgent } = await import("../../resolve-agent.js");
        const resolved = await resolveAgent({
          manifestPath: ctx.manifestPath,
          manifest: loadResult.value.manifest,
        });
        if (!resolved.ok) {
          throw new Error(`Agent resolution failed: ${resolved.error.code}`);
        }
        onProgress("Agent resolved");
      },
    },
    {
      id: "runtime",
      label: "Starting runtime",
      execute: async (ctx, onProgress) => {
        onProgress("Booting services in-process");
        const { bootRuntime } = await import("./boot-runtime.js");
        const handle = await bootRuntime({
          manifestPath: ctx.manifestPath,
          workspaceRoot: ctx.workspaceRoot,
          verbose: ctx.verbose,
          adminPort: ctx.adminPort,
          onProgress: (_phase, msg) => {
            onProgress(msg);
          },
        });
        // Store the handle on context for the caller to manage lifecycle
        ctx.runtimeHandle = handle;
        onProgress(`Admin API ready at ${handle.adminUrl}`);
      },
    },
  ];
}

/**
 * Start the Koi stack with phase progress callbacks.
 *
 * Runs real validation (manifest, preflight, agent resolve) then boots
 * the runtime in-process and stores the handle on context for cleanup.
 */
export async function startStack(
  context: StartStackContext,
  callbacks: PhaseCallbacks,
): Promise<OperationResult<void>> {
  const phases = createStartupPhases();
  return runPhases(phases, context, callbacks);
}
