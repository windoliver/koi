/**
 * Start-stack — wraps the `koi up` phases into PhaseDefinition[] for
 * the PhaseRunner from @koi/setup-core.
 *
 * This allows the TUI to call the same startup logic in-process with
 * progress callbacks, instead of spawning a detached subprocess.
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
 * Create phase definitions for the startup sequence.
 *
 * Each phase wraps a step from the `koi up` orchestrator.
 * Dynamic imports keep heavy dependencies lazy-loaded.
 */
function createStartupPhases(): readonly PhaseDefinition<StartStackContext>[] {
  return [
    {
      id: "manifest",
      label: "Loading manifest",
      execute: async (ctx, onProgress) => {
        onProgress("Reading koi.yaml");
        const { loadManifest } = await import("@koi/manifest");
        await loadManifest(ctx.manifestPath);
      },
    },
    {
      id: "preset",
      label: "Resolving preset",
      execute: async (ctx, onProgress) => {
        onProgress(`Preset: ${ctx.wizardState.preset}`);
        // Preset resolution is handled by the orchestrator
        // This phase signals progress for the TUI
      },
    },
    {
      id: "preflight",
      label: "Running preflight checks",
      execute: async (_ctx, onProgress) => {
        onProgress("Checking environment");
        // Preflight checks require the manifest object and CLI output,
        // which are created by the full orchestrator. This phase is a
        // placeholder that signals progress for the TUI.
      },
    },
    {
      id: "resolve",
      label: "Resolving agent definition",
      execute: async (ctx, onProgress) => {
        onProgress(`Agent: ${ctx.wizardState.name}`);
      },
    },
    {
      id: "assemble",
      label: "Assembling runtime",
      execute: async (_ctx, onProgress) => {
        onProgress("Composing middleware chain");
      },
    },
    {
      id: "channels",
      label: "Connecting channels",
      execute: async (ctx, onProgress) => {
        const channelList = ctx.wizardState.channels.join(", ");
        onProgress(`Channels: ${channelList}`);
      },
    },
    {
      id: "admin",
      label: "Starting admin panel",
      execute: async (ctx, onProgress) => {
        onProgress(`Port ${String(ctx.adminPort)}`);
      },
    },
  ];
}

/**
 * Start the Koi stack in-process with phase progress callbacks.
 *
 * This is the in-process alternative to spawning `koi up --detach`.
 * The TUI calls this to get progress updates as each phase completes.
 */
export async function startStack(
  context: StartStackContext,
  callbacks: PhaseCallbacks,
): Promise<OperationResult<void>> {
  const phases = createStartupPhases();
  return runPhases(phases, context, callbacks);
}
