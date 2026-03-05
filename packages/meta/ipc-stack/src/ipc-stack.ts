/**
 * createIpcStack — IPC subsystem assembly.
 *
 * Composes messaging, delegation, workspace, scratchpad, and federation
 * into a single IpcBundle with providers, middlewares, and disposables.
 *
 * Subsystem composition order:
 *   1. Messaging (local router or nexus provider)
 *   2. Delegation (task-spawn, parallel-minions, or orchestrator)
 *   3. Workspace (optional)
 *   4. Scratchpad (local component or nexus provider + flush middleware)
 *   5. Federation (middleware + optional sync engine)
 */

import type { ComponentProvider, KoiMiddleware } from "@koi/core";
import { SCRATCHPAD } from "@koi/core";
import type { SyncEngineHandle } from "@koi/federation";
import { createFederationMiddleware, createSyncEngine } from "@koi/federation";
import type { MailboxRouter } from "@koi/ipc-local";
import { createLocalMailboxRouter } from "@koi/ipc-local";
import { createIpcNexusProvider } from "@koi/ipc-nexus";
import { createOrchestratorProvider, mapSpawnToWorker } from "@koi/orchestrator";
import { createParallelMinionsProvider, mapSpawnToMinion } from "@koi/parallel-minions";
import { createLocalScratchpad } from "@koi/scratchpad-local";
import { createScratchpadNexusProvider } from "@koi/scratchpad-nexus";
import { createTaskSpawnProvider, mapSpawnToTask } from "@koi/task-spawn";
import { createWorkspaceProvider } from "@koi/workspace";

import { resolveIpcConfig } from "./config-resolution.js";
import type { IpcBundle, IpcStackConfig, ResolvedIpcMeta } from "./types.js";

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Assemble an IPC subsystem stack.
 *
 * Returns an `IpcBundle` with `providers`, `middlewares`, `disposables`,
 * and metadata. Pass `providers` and `middlewares` directly to createKoi():
 *
 * ```typescript
 * const { providers, middlewares, router } = createIpcStack({
 *   preset: "local",
 *   spawn: mySpawnFn,
 * });
 * const runtime = await createKoi({ ..., middleware: middlewares, providers });
 * ```
 *
 * Config resolution: defaults -> preset -> user overrides.
 */
export function createIpcStack(config: IpcStackConfig): IpcBundle {
  const resolved = resolveIpcConfig(config);

  const providers: ComponentProvider[] = [];
  const middlewares: KoiMiddleware[] = [];
  const disposables: Disposable[] = [];

  // let: assigned conditionally based on messaging kind
  let router: MailboxRouter | undefined;
  // let: assigned conditionally based on federation config
  let syncEngine: SyncEngineHandle | undefined;

  // ── 1. Messaging ────────────────────────────────────────────────────────
  const messaging = resolved.messaging;
  if (messaging !== undefined) {
    if (messaging.kind === "local") {
      router = createLocalMailboxRouter();
    } else if (messaging.kind === "nexus" && messaging.config !== undefined) {
      const provider = createIpcNexusProvider(messaging.config);
      providers.push(provider);
    }
  }

  // ── 2. Delegation ──────────────────────────────────────────────────────
  const delegation = resolved.delegation;
  if (delegation !== undefined) {
    if (delegation.kind === "task-spawn") {
      const taskSpawn = mapSpawnToTask(config.spawn);
      const provider = createTaskSpawnProvider({
        ...delegation.config,
        spawn: taskSpawn,
      });
      providers.push(provider);
    } else if (delegation.kind === "parallel-minions") {
      const minionSpawn = mapSpawnToMinion(config.spawn);
      const provider = createParallelMinionsProvider({
        ...delegation.config,
        spawn: minionSpawn,
      });
      providers.push(provider);
    } else if (delegation.kind === "orchestrator") {
      const workerSpawn = mapSpawnToWorker(
        config.spawn,
        "orchestrator",
        delegation.config.maxUpstreamContextPerTask,
      );
      const provider = createOrchestratorProvider({
        ...delegation.config,
        spawn: workerSpawn,
      });
      providers.push(provider);
    }
  }

  // ── 3. Workspace ───────────────────────────────────────────────────────
  if (resolved.workspace !== undefined) {
    const result = createWorkspaceProvider(resolved.workspace);
    if (!result.ok) {
      throw new Error(
        `[@koi/ipc-stack] Workspace provider creation failed: ${result.error.message}`,
        { cause: result.error },
      );
    }
    providers.push(result.value);
  }

  // ── 4. Scratchpad ──────────────────────────────────────────────────────
  const scratchpad = resolved.scratchpad;
  if (scratchpad !== undefined) {
    if (scratchpad.kind === "local") {
      const backend = createLocalScratchpad(scratchpad.config);
      const provider: ComponentProvider = {
        name: "koi:scratchpad-local",
        attach: async (): Promise<ReadonlyMap<string, unknown>> => {
          return new Map<string, unknown>([[String(SCRATCHPAD), backend]]);
        },
      };
      providers.push(provider);
      disposables.push({ [Symbol.dispose]: () => backend.close() });
    } else if (scratchpad.kind === "nexus") {
      const result = createScratchpadNexusProvider(scratchpad.config);
      providers.push(result.provider);
      middlewares.push(result.middleware);
    }
  }

  // ── 5. Federation ──────────────────────────────────────────────────────
  const federation = resolved.federation;
  if (federation !== undefined) {
    if (federation.middleware !== undefined) {
      const mw = createFederationMiddleware(federation.middleware);
      middlewares.push(mw);
    }
    if (federation.sync !== undefined) {
      syncEngine = createSyncEngine(federation.sync);
      disposables.push({
        [Symbol.dispose]: () => {
          // SyncEngineHandle is AsyncDisposable — wrap in Promise.resolve
          // for proper error handling. Callers needing reliable cleanup
          // should use syncEngine[Symbol.asyncDispose]() directly.
          Promise.resolve(syncEngine?.[Symbol.asyncDispose]()).catch((_: unknown) => {
            // Disposal failures are transient (pending sync flushes).
          });
        },
      });
    }
  }

  // ── Build metadata ─────────────────────────────────────────────────────
  const meta: ResolvedIpcMeta = {
    preset: resolved.preset ?? "local", // already normalized by resolveIpcConfig
    messagingKind: messaging?.kind ?? "none",
    delegationKind: delegation?.kind ?? "none",
    scratchpadKind: scratchpad?.kind ?? "none",
    workspaceEnabled: resolved.workspace !== undefined,
    federationEnabled: federation !== undefined,
    providerCount: providers.length,
    middlewareCount: middlewares.length,
  };

  return {
    providers: Object.freeze(providers),
    middlewares: Object.freeze(middlewares),
    disposables: Object.freeze(disposables),
    config: meta,
    ...(router !== undefined ? { router } : {}),
    ...(syncEngine !== undefined ? { syncEngine } : {}),
  };
}
