/**
 * Start-stack — runs `koi up` in-process with progress callbacks.
 *
 * Delegates to the full runUp() orchestrator, mapping its phases
 * to PhaseCallbacks for the TUI progress view.
 */

import type {
  OperationResult,
  PhaseCallbacks,
  PhaseDefinition,
  SetupWizardState,
} from "@koi/setup-core";
import { runPhases } from "@koi/setup-core";

/** Context passed through all startup phases. */
export interface StartStackContext {
  readonly wizardState: SetupWizardState;
  readonly manifestPath: string;
  readonly workspaceRoot: string;
  readonly verbose: boolean;
  readonly adminPort: number;
}

/**
 * Create phase definitions that call the real koi up orchestrator.
 */
function createStartupPhases(): readonly PhaseDefinition<StartStackContext>[] {
  return [
    {
      id: "manifest",
      label: "Loading manifest",
      execute: async (ctx, onProgress) => {
        onProgress("Reading koi.yaml");
        const { loadManifest } = await import("@koi/manifest");
        const result = await loadManifest(ctx.manifestPath);
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
        const loadResult = await loadManifest(ctx.manifestPath);
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
        const loadResult = await loadManifest(ctx.manifestPath);
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
      id: "channels",
      label: "Connecting channels",
      execute: async (ctx, onProgress) => {
        const channelList = ctx.wizardState.channels.join(", ");
        onProgress(`Channels: ${channelList}`);
        // Channel connections are established when the full runtime starts.
        // In the TUI welcome flow, the admin API starts separately.
      },
    },
    {
      id: "admin",
      label: "Starting admin panel",
      execute: async (ctx, onProgress) => {
        onProgress(`Port ${String(ctx.adminPort)}`);
        // The admin panel is started by runUp() when the full runtime boots.
        // After startStack completes, the caller spawns `koi up` to start
        // the actual services, then transitions to boardroom.
      },
    },
  ];
}

/**
 * Start the Koi stack with phase progress callbacks.
 *
 * Runs real preflight checks and agent resolution before the full
 * startup. The caller is responsible for actually starting the runtime
 * (via `koi up` subprocess or direct `runUp()` call) after this returns.
 */
export async function startStack(
  context: StartStackContext,
  callbacks: PhaseCallbacks,
): Promise<OperationResult<void>> {
  const phases = createStartupPhases();
  return runPhases(phases, context, callbacks);
}
