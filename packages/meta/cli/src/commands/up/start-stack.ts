/**
 * Start-stack — runs koi startup in-process with progress callbacks.
 *
 * Phases 1-4 perform real validation (manifest, preset, preflight, agent resolve).
 * Phase 5 boots the runtime via `koi up --detach` and polls health.
 *
 * The detached process is necessary because `runUp()` blocks on the REPL loop
 * and owns the terminal. The TUI is already rendering, so we run the runtime
 * in a separate process and wait for its admin API to become healthy.
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
  readonly adminUrl: string;
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
      id: "runtime",
      label: "Starting runtime",
      execute: async (ctx, onProgress) => {
        onProgress("Booting runtime process");
        // runUp() is a blocking function that owns the terminal (REPL + channels).
        // Since the TUI is already rendering, we start the runtime as a detached
        // process and poll its admin API for health.
        const { spawn } = await import("node:child_process");
        const bunPath = process.argv[0] ?? "bun";
        const cliEntry = new URL("../../bin.ts", import.meta.url).pathname;
        const child = spawn(bunPath, [cliEntry, "up", "--detach"], {
          detached: true,
          stdio: "ignore",
          cwd: ctx.workspaceRoot,
        });
        child.unref();

        // Poll admin API for health
        onProgress("Waiting for admin API...");
        const maxAttempts = 60;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const res = await fetch(`${ctx.adminUrl}/health`, {
              signal: AbortSignal.timeout(2000),
            });
            if (res.ok) {
              onProgress("Admin API healthy");
              return;
            }
          } catch {
            // Not ready yet
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error(
          "Admin API did not become healthy within 30 seconds. Run `koi doctor` for diagnostics.",
        );
      },
    },
  ];
}

/**
 * Start the Koi stack with phase progress callbacks.
 *
 * Runs real validation (manifest, preflight, agent resolve) then boots
 * the runtime process and waits for admin API health.
 */
export async function startStack(
  context: StartStackContext,
  callbacks: PhaseCallbacks,
): Promise<OperationResult<void>> {
  const phases = createStartupPhases();
  return runPhases(phases, context, callbacks);
}
