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
  /** Path to Nexus source repo for --nexus-source. */
  readonly nexusSource: string | undefined;
  /** Build Nexus from source before starting. */
  readonly nexusBuild: boolean;
  /** Override the Nexus HTTP port. */
  readonly nexusPort: number | undefined;
  /** Set by the nexus phase — base URL of the running Nexus instance. Mutable by design. */
  nexusBaseUrl?: string | undefined;
  /** Set by the nexus phase — true if we started Nexus ourselves. Mutable by design. */
  nexusStartedByUs?: boolean | undefined;
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
      id: "nexus",
      label: "Starting Nexus",
      execute: async (ctx, onProgress) => {
        // Run build-from-source if flags are set
        if (ctx.nexusBuild && ctx.nexusSource !== undefined) {
          onProgress("Building Nexus from source");
          const { runNexusBuildIfNeeded } = await import("../../resolve-nexus.js");
          runNexusBuildIfNeeded(ctx.nexusBuild, ctx.nexusSource);
        }

        // Check if preset requires embedded Nexus
        const { inferPresetId } = await import("./preset.js");
        const presetId = await inferPresetId(ctx.manifestPath);
        const { resolveRuntimePreset } = await import("@koi/runtime-presets");
        const { resolved: preset } = resolveRuntimePreset(presetId);

        if (preset.nexusMode !== "embed-auth" || process.env.KOI_NEXUS_SKIP === "1") {
          onProgress("Nexus not required for this preset");
          return;
        }

        // Skip if Nexus URL already provided via env or manifest
        const { loadManifest } = await import("@koi/manifest");
        const loadResult = await loadManifest(ctx.manifestPath);
        const manifestNexusUrl = loadResult.ok ? loadResult.value.manifest.nexus?.url : undefined;
        const existingUrl = manifestNexusUrl ?? process.env.NEXUS_URL;
        if (existingUrl !== undefined) {
          ctx.nexusBaseUrl = existingUrl;
          onProgress("Using existing Nexus URL");
          return;
        }

        // Start Nexus with auto port strategy
        onProgress("Starting Nexus stack (pulling Docker images, this may take a minute…)");
        const { startNexusStack } = await import("./nexus.js");
        const nexusResult = await startNexusStack(ctx.workspaceRoot, presetId, ctx.verbose, {
          build: ctx.nexusBuild || undefined,
          sourceDir: ctx.nexusSource,
          port: ctx.nexusPort,
          portStrategy: "auto",
        });
        if (nexusResult !== undefined) {
          ctx.nexusBaseUrl = nexusResult.baseUrl;
          ctx.nexusStartedByUs = true;
          if (nexusResult.apiKey !== undefined && process.env.NEXUS_API_KEY === undefined) {
            process.env.NEXUS_API_KEY = nexusResult.apiKey;
          }
          onProgress(`Nexus ready at ${nexusResult.baseUrl}`);
        } else {
          onProgress("Nexus startup failed (non-fatal)");
        }
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
        // Build nexus cleanup callback if we started Nexus ourselves
        let nexusCleanup: (() => Promise<void>) | undefined;
        if (ctx.nexusStartedByUs === true) {
          nexusCleanup = async () => {
            const { stopNexusStack } = await import("./nexus.js");
            await stopNexusStack(ctx.workspaceRoot, ctx.verbose);
          };
        }
        const handle = await bootRuntime({
          manifestPath: ctx.manifestPath,
          workspaceRoot: ctx.workspaceRoot,
          verbose: ctx.verbose,
          adminPort: ctx.adminPort,
          nexusBaseUrl: ctx.nexusBaseUrl,
          nexusCleanup,
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
  const result = await runPhases(phases, context, callbacks);

  // Clean up Nexus if we started it and a later phase failed
  if (!result.ok && context.nexusStartedByUs === true) {
    try {
      const { stopNexusStack } = await import("./nexus.js");
      await stopNexusStack(context.workspaceRoot, context.verbose);
    } catch {
      // Best-effort cleanup — don't mask the original error
    }
    context.nexusStartedByUs = false;
  }

  return result;
}
