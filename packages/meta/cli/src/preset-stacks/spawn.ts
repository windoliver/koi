/**
 * Spawn preset stack — child agent resolution + spawn tool provider.
 *
 * Late-phase stack: activates AFTER the factory has built its core
 * middleware so the child-inheritance list can reference already-
 * composed permissions / hook / exfiltration-guard / system-prompt
 * middleware. Early stacks can't do this without introducing a
 * forward reference — the spawn stack is the canonical example of
 * why `StackPhase.late` exists.
 *
 * Reads from `ctx.host`:
 *   - `inheritedMiddleware` — the already-composed security +
 *     policy middleware that children should inherit. Populated by
 *     the factory between early-phase activation and late-phase
 *     activation.
 *   - `onSpawnEvent` (optional) — host callback for spawn lifecycle
 *     events (TUI bridges this into its store for the /agents view).
 *
 * Contributes:
 *   - `spawnToolProvider` — the Spawn tool that lets the parent
 *     agent launch child agents.
 */

import { homedir } from "node:os";
import { createAgentResolver } from "@koi/agent-runtime";
import type {
  Agent,
  AgentId,
  ComponentProvider,
  EngineAdapter,
  KoiMiddleware,
  ManagedTaskBoard,
  ModelAdapter,
  SpawnFn,
  TaskBoardStore,
} from "@koi/core";
import {
  createAgentSpawnFn,
  createInMemorySpawnLedger,
  createSpawnToolProvider,
  DEFAULT_SPAWN_POLICY,
  type SpawnPolicy,
} from "@koi/engine";
import { runTurn } from "@koi/query-engine";
import {
  createLocalAgentLifecycle,
  createTaskRegistry,
  createTaskRunner,
  type LocalAgentConfig,
  type TaskRunner,
} from "@koi/tasks";
import type { PresetStack, StackContribution } from "../preset-stacks.js";
import { LATE_PHASE_HOST_KEYS } from "../preset-stacks.js";
import { AGENT_ID_HOST_KEY } from "./execution.js";

/** Key under `ctx.host` for the optional spawn-event callback. */
export const SPAWN_EVENT_CALLBACK_HOST_KEY = "onSpawnEvent";
/** Key under `ctx.host` for the host's model name (used in manifest template). */
export const MODEL_NAME_HOST_KEY = "modelName";

/** Child agent `DEFAULT_MAX_TURNS` — matches parent factory (`runtime-factory.ts`). */
const CHILD_MAX_TURNS = 25;

type SpawnEventCallback = (event: {
  readonly kind: "spawn_requested" | "agent_status_changed";
  readonly agentId: string;
  readonly agentName: string;
  readonly description: string;
  readonly status?: "running" | "complete" | "failed";
}) => void;

function buildChildAdapter(modelAdapter: ModelAdapter, hostId: string): EngineAdapter {
  return {
    engineId: `${hostId}-child`,
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: { modelCall: modelAdapter.complete, modelStream: modelAdapter.stream },
    stream(input) {
      const handlers = input.callHandlers;
      if (handlers === undefined) {
        return (async function* () {
          yield {
            kind: "done" as const,
            output: {
              content: [],
              stopReason: "error" as const,
              metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
              metadata: { error: "No callHandlers on child agent input" },
            },
          };
        })();
      }
      const text = input.kind === "text" ? input.text : "";
      const messages = [
        { senderId: "user", timestamp: Date.now(), content: [{ kind: "text" as const, text }] },
      ];
      return runTurn({
        callHandlers: handlers,
        messages,
        signal: input.signal,
        maxTurns: CHILD_MAX_TURNS,
      });
    },
  };
}

export const spawnStack: PresetStack = {
  id: "spawn",
  description: "Child agent spawning (resolver + child adapter + Spawn tool)",
  phase: "late",
  activate: (ctx): StackContribution => {
    if (ctx.modelAdapter === undefined) {
      // Spawn requires a real model adapter for child turns. Without
      // one (e.g. a lightweight test host), skip silently — the Spawn
      // tool just won't be registered.
      return { middleware: [], providers: [] };
    }

    const inheritedMiddleware =
      (ctx.host?.[LATE_PHASE_HOST_KEYS.inheritedMiddleware] as
        | readonly KoiMiddleware[]
        | undefined) ?? [];
    // Host-owned factory that re-resolves manifest-declared
    // middleware fresh per child. Threaded from the runtime
    // factory when the runtime has zone-B middleware; children
    // get their own per-session state (audit queue + hash chain
    // + lifecycle hooks) rather than sharing the parent's
    // mutable instances. Absent when the runtime has no zone-B
    // middleware, in which case children just inherit the static
    // security + system-prompt layers.
    const perChildManifestMiddlewareFactory = ctx.host?.[
      LATE_PHASE_HOST_KEYS.perChildManifestMiddlewareFactory
    ] as
      | ((childCtx: {
          readonly childRunId: string;
          readonly parentAgentId: string;
          readonly childAgentId: string;
          readonly childAgentName: string;
        }) => Promise<{
          readonly middleware: readonly KoiMiddleware[];
          readonly unwind?: () => Promise<void> | void;
        }>)
      | undefined;
    const onSpawnEvent = ctx.host?.[SPAWN_EVENT_CALLBACK_HOST_KEY] as
      | SpawnEventCallback
      | undefined;
    const modelName = (ctx.host?.[MODEL_NAME_HOST_KEY] as string | undefined) ?? "unknown";

    const { resolver, warnings } = createAgentResolver({
      projectDir: ctx.cwd,
      userDir: homedir(),
    });
    for (const w of warnings) {
      console.warn(`[koi/${ctx.hostId}] agent load warning: ${w.filePath}: ${w.error.message}`);
    }

    const childAdapter = buildChildAdapter(ctx.modelAdapter, ctx.hostId);

    const spawnToolProvider = createSpawnToolProvider({
      resolver,
      spawnLedger: createInMemorySpawnLedger(5),
      adapter: childAdapter,
      manifestTemplate: {
        name: "spawned-agent",
        version: "0.0.0",
        description: "Spawned sub-agent",
        model: { name: modelName },
        selfCeiling: {
          tools: ["Glob", "Grep", "fs_read", "ToolSearch"],
        },
      },
      inheritedMiddleware,
      ...(perChildManifestMiddlewareFactory !== undefined
        ? { perChildMiddlewareFactory: perChildManifestMiddlewareFactory }
        : {}),
      allowDynamicAgents: true,
      ...(onSpawnEvent !== undefined ? { onSpawnEvent } : {}),
    });

    // --- local_agent task runner ---
    // Reads task board and store getters threaded from execution stack.
    // When absent (execution stack not active), skip the runner setup.
    const getTaskBoard = ctx.host?.[LATE_PHASE_HOST_KEYS.getTaskBoard] as
      | (() => ManagedTaskBoard)
      | undefined;
    const getStore = ctx.host?.[LATE_PHASE_HOST_KEYS.getStore] as
      | (() => TaskBoardStore)
      | undefined;
    const agentId = ctx.host?.[AGENT_ID_HOST_KEY] as AgentId | undefined;

    if (getTaskBoard === undefined || getStore === undefined || agentId === undefined) {
      return {
        middleware: [],
        providers: [spawnToolProvider],
      };
    }

    // Narrowed non-optional references — guards above prove these are defined.
    const boardGetter: () => ManagedTaskBoard = getTaskBoard;
    const storeGetter: () => TaskBoardStore = getStore;
    const resolvedAgentId: AgentId = agentId;

    // let: mutable — set once in localAgentRunnerProvider.attach()
    let spawnFnRef: SpawnFn | undefined;
    // let: mutable — recreated on session reset
    let currentRunner: TaskRunner | undefined;
    // let: mutable — unsubscribe from the pending-task auto-start watcher
    let currentWatcherUnsubscribe: (() => void) | undefined;

    const LOCAL_AGENT_SPAWN_POLICY: SpawnPolicy = {
      ...DEFAULT_SPAWN_POLICY,
      maxTotalProcesses: 10,
    };

    function startLocalAgentRunner(): void {
      if (spawnFnRef === undefined) return;
      const capturedSpawnFn = spawnFnRef;

      // Dispose previous runner + watcher before creating the new ones.
      currentWatcherUnsubscribe?.();
      currentWatcherUnsubscribe = undefined;
      void currentRunner?.[Symbol.asyncDispose]();

      const registry = createTaskRegistry();
      registry.register(
        createLocalAgentLifecycle() as unknown as import("@koi/tasks").TaskKindLifecycle,
      );

      const currentStore = storeGetter();
      const runner = createTaskRunner({
        board: boardGetter(),
        store: currentStore,
        registry,
        agentId: resolvedAgentId,
      });
      currentRunner = runner;

      // Auto-start pending local_agent tasks created on this store.
      currentWatcherUnsubscribe = currentStore.watch((event) => {
        if (event.kind !== "put") return;
        const { item } = event;
        if (item.status !== "pending") return;
        if (item.metadata?.["kind"] !== "local_agent") return;

        const rawAgentType: unknown = item.metadata?.["agentType"];
        const localAgentType = typeof rawAgentType === "string" ? rawAgentType : item.subject;
        const localInputs: unknown = item.metadata?.["inputs"] ?? item.description;

        const taskConfig: LocalAgentConfig = {
          agentType: localAgentType,
          inputs: localInputs,
          run(_runAgentType: string, runInputs: unknown, signal: AbortSignal) {
            // eslint-disable-next-line no-restricted-syntax
            return (async function* () {
              const result = await capturedSpawnFn({
                agentName: _runAgentType,
                description: typeof runInputs === "string" ? runInputs : JSON.stringify(runInputs),
                signal,
                nonInteractive: true,
              });
              if (!result.ok) throw new Error(result.error.message);
              yield result.output;
            })();
          },
        };

        void runner.start(item.id, "local_agent", taskConfig);
      });
    }

    const localAgentRunnerProvider: ComponentProvider = {
      name: "local-agent-runner",
      attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
        spawnFnRef = createAgentSpawnFn({
          resolver,
          base: {
            parentAgent: agent,
            spawnLedger: createInMemorySpawnLedger(5),
            spawnPolicy: LOCAL_AGENT_SPAWN_POLICY,
          },
          adapter: childAdapter,
          manifestTemplate: {
            name: "spawned-agent",
            version: "0.0.0",
            description: "Spawned sub-agent",
            model: { name: modelName },
            selfCeiling: { tools: ["Glob", "Grep", "fs_read", "ToolSearch"] },
          },
          inheritedMiddleware,
          ...(perChildManifestMiddlewareFactory !== undefined
            ? { perChildMiddlewareFactory: perChildManifestMiddlewareFactory }
            : {}),
          allowDynamicAgents: true,
        });
        startLocalAgentRunner();
        return new Map<string, unknown>();
      },
    };

    return {
      middleware: [],
      providers: [spawnToolProvider, localAgentRunnerProvider],
      onResetSession: (): void => {
        // execution stack's onResetSession already rotated board + store.
        // getTaskBoard()/getStore() now return the fresh instances.
        startLocalAgentRunner();
      },
      onShutdown: (): boolean => {
        currentWatcherUnsubscribe?.();
        currentWatcherUnsubscribe = undefined;
        void currentRunner?.[Symbol.asyncDispose]();
        currentRunner = undefined;
        return false;
      },
    };
  },
};
