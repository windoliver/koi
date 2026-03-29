/**
 * Autonomous agent factory — composes harness + scheduler + optional compactor
 * into a coordinated autonomous agent with checkpoint/inbox support.
 *
 * ## Forge → Delegation Bridge (auto-enabled)
 *
 * Pass `forgeStore` to enable automatic agent discovery via the forge:
 *
 *   const agent = createAutonomousAgent({ harness, scheduler, forgeStore });
 *
 * This auto-creates a CatalogAgentResolver that:
 *   - Discovers agent bricks from the forge matching requested type tags
 *   - Selects the best brick by fitness score (weighted random)
 *   - Parses and caches manifests (TTL-based)
 *
 * The resolver is exposed on the returned `agent.agentResolver` and can be
 * passed directly to delegation tool configs:
 *
 *   const config: ParallelMinionsConfig = {
 *     agentResolver: agent.agentResolver,
 *     spawn: mySpawnFn,
 *   };
 *
 * For spawn fitness tracking, also pass `healthRecorder` and wrap your
 * spawn function with `createSpawnFitnessWrapper()`:
 *
 *   import { createSpawnFitnessWrapper, embedBrickId } from "@koi/autonomous";
 *
 *   const wrappedSpawn = createSpawnFitnessWrapper(rawSpawn, { healthRecorder });
 *
 * Spawn outcomes feed back into brick fitness scores, so higher-performing
 * agent bricks are selected more often over time.
 *
 * Disposal order: stop scheduler first (prevents new resumes), then dispose harness.
 */

import { createCatalogAgentResolver } from "@koi/catalog";
import type {
  Agent,
  AgentMessageInput,
  AgentResolver,
  AttachResult,
  ComponentProvider,
  HarnessThreadSnapshot,
  InboxComponent,
  InboxPolicy,
  KoiMiddleware,
  MailboxComponent,
  TaskBoard,
  TaskBoardSnapshot,
  TaskItem,
  TaskItemId,
  ThreadMetrics,
} from "@koi/core";
import { agentId, INBOX, MAILBOX, threadId } from "@koi/core";
import { createGoalStack, createTaskAwareDrifting, createTaskBoardSource } from "@koi/goal-stack";
import type { DelegationBridge } from "@koi/long-running";
import {
  createAutonomousProvider,
  createCheckpointMiddleware,
  createDelegationBridge,
  createInboxMiddleware,
  createPlanAutonomousProvider,
  createTaskTools,
} from "@koi/long-running";
import { createTaskBoard } from "@koi/task-board";
import type { AutonomousAgent, AutonomousAgentParts } from "./types.js";

// ---------------------------------------------------------------------------
// Bridge helpers
// ---------------------------------------------------------------------------

/** Check if any task items in a snapshot use spawn delegation. */
function hasSpawnTasks(snapshot: TaskBoardSnapshot): boolean {
  return snapshot.items.some((item) => item.delegation === "spawn");
}

/** Callback to notify the copilot about per-task state changes. */
type TaskNotifyFn = (taskId: TaskItemId, item: TaskItem, output?: string) => void;

/**
 * Hydrate a live TaskBoard from a snapshot, dispatch ready spawn tasks
 * via the bridge, then write the updated state back to the harness.
 *
 * The bridge internally runs assign → spawn → complete on a transient live
 * board. We must replay those transitions into the harness in the right order
 * (assign before complete) because the harness enforces status preconditions.
 */
async function dispatchSpawnTasks(
  bridge: DelegationBridge,
  snapshot: TaskBoardSnapshot,
  harness: AutonomousAgentParts["harness"],
  notify?: TaskNotifyFn | undefined,
): Promise<void> {
  if (!hasSpawnTasks(snapshot)) return;

  const liveBoard: TaskBoard = createTaskBoard(undefined, snapshot);
  const updatedBoard = await bridge.dispatchReady(liveBoard);

  // Write transitions back to harness in correct order.
  //
  // The bridge runs assign → spawn → complete/fail atomically on a transient
  // board. For retryable failures, the board goes: pending → assigned → fail →
  // pending (with retries incremented). We detect all three cases:
  //   1. Successful dispatch: item ended as "completed"
  //   2. Terminal failure: item ended as "failed" (retries exhausted)
  //   3. Retryable failure: item ended as "pending" but retries > original
  for (const item of updatedBoard.all()) {
    const original = snapshot.items.find((i) => i.id === item.id);
    if (original === undefined) continue;

    const wasDispatched =
      // Moved out of pending (success or terminal failure)
      (original.status === "pending" && item.status !== "pending") ||
      // Retryable failure: back to pending but retries incremented
      (original.status === "pending" &&
        item.status === "pending" &&
        item.retries > original.retries);

    if (!wasDispatched) continue;

    // Step 1: assign in harness (pending → assigned)
    const assignResult = await harness.assignTask(
      item.id,
      item.assignedTo ?? agentId(`worker-${item.id}`),
    );
    if (!assignResult.ok) {
      process.stderr.write(
        `[autonomous] assignTask failed for ${item.id}: ${assignResult.error.message}\n`,
      );
      continue;
    }

    // Step 2a: complete (assigned → completed)
    if (item.status === "completed") {
      const result = updatedBoard.result(item.id);
      if (result !== undefined) {
        const completeResult = await harness.completeTask(item.id, result);
        if (!completeResult.ok) {
          process.stderr.write(
            `[autonomous] completeTask failed for ${item.id}: ${completeResult.error.message}\n`,
          );
        } else {
          notify?.(item.id, item, result.output);
        }
      }
      continue;
    }

    // Step 2b: fail (assigned → failed or assigned → pending via retryable)
    // For both terminal and retryable failures, call failTask which handles
    // the retry-count check and status transition internally.
    if (item.error !== undefined) {
      const failResult = await harness.failTask(item.id, item.error);
      if (!failResult.ok) {
        process.stderr.write(
          `[autonomous] failTask failed for ${item.id}: ${failResult.error.message}\n`,
        );
      } else {
        notify?.(item.id, item);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAutonomousAgent(parts: AutonomousAgentParts): AutonomousAgent {
  // let justified: mutable disposal guard
  let disposed = false;

  // let justified: mutable agent reference — captured at attach time by
  // the autonomous-provider so inbox getters can resolve ECS components.
  // Undefined until the first provider.attach() fires during agent assembly.
  let attachedAgent: Agent | undefined;

  // Per-task notification — sends mailbox messages when spawn tasks complete/fail.
  // The copilot receives these on its next turn via inbox-middleware.
  const notifyTask: TaskNotifyFn = (taskId, item, output) => {
    const mailbox = attachedAgent?.component(MAILBOX) as MailboxComponent | undefined;
    if (mailbox === undefined) return;

    const isCompleted = item.status === "completed";
    const preview = output !== undefined ? output.slice(0, 500) : undefined;

    const message: AgentMessageInput = {
      from: agentId(parts.harness.harnessId),
      to: attachedAgent?.pid.id ?? agentId("copilot"),
      kind: "event",
      type: isCompleted ? "task.completed" : "task.failed",
      payload: {
        taskId,
        status: item.status,
        agentType: item.agentType,
        ...(preview !== undefined ? { outputPreview: preview } : {}),
        ...(item.error !== undefined
          ? { errorMessage: item.error.message, retryable: item.error.retryable }
          : {}),
      },
      metadata: { mode: item.status === "completed" ? "steer" : "followup" },
    };

    // Fire-and-forget — notification failure should never block dispatch
    void mailbox.send(message).then((result) => {
      if (!result.ok) {
        process.stderr.write(
          `[autonomous] task notification failed for ${taskId}: ${result.error.message}\n`,
        );
      }
    });
  };

  // Delegation bridge — lazily created when a plan with spawn tasks is created
  // and a spawn function is available via the getSpawn getter.
  // let justified: mutable ref, created on first plan with spawn tasks.
  let bridge: DelegationBridge | undefined;

  // --- Build middleware list ---
  const middlewareList: KoiMiddleware[] = [parts.harness.createMiddleware()];

  // Checkpoint middleware — only when threadStore provided
  if (parts.threadStore !== undefined) {
    const threadStore = parts.threadStore;
    middlewareList.push(
      createCheckpointMiddleware({
        policy: parts.checkpointPolicy,
        onCheckpoint: async (ctx) => {
          // Build a HarnessThreadSnapshot from current harness state.
          // threadId is derived from harnessId (1:1 mapping).
          const status = parts.harness.status();
          const metrics: ThreadMetrics = {
            totalMessages: status.metrics.totalTurns, // best approximation available
            totalTurns: status.metrics.totalTurns,
            totalTokens: status.metrics.totalInputTokens + status.metrics.totalOutputTokens,
            lastActivityAt: Date.now(),
          };
          const snapshot: HarnessThreadSnapshot = {
            kind: "harness",
            threadId: threadId(status.harnessId),
            agentId: agentId(status.harnessId), // agentId not available on harness interface; use harnessId as stable proxy
            taskBoard: status.taskBoard,
            summaries: [], // summaries are internal to harness and not exposed via HarnessStatus
            metrics,
            createdAt: Date.now(),
          };
          const checkpointResult = await threadStore.appendAndCheckpoint(
            threadId(status.harnessId),
            [], // no individual thread messages to append for harness-type checkpoints
            snapshot,
          );
          if (!checkpointResult.ok) {
            // Surface checkpoint failures — silent loss of autonomous state is
            // worse than a noisy error. Callers can catch and decide policy.
            throw new Error(
              `Autonomous checkpoint failed for harness ${status.harnessId}: ${checkpointResult.error.message}`,
              { cause: checkpointResult.error },
            );
          }
          void ctx.trigger; // trigger is informational; checkpoint is unconditional here
        },
      }),
    );
  }

  // Inbox middleware — routes mailbox messages to inbox queue.
  // getMailbox/getInbox resolve via the attached agent reference,
  // which is captured when the autonomous-provider fires attach().
  if (parts.threadStore !== undefined) {
    middlewareList.push(
      createInboxMiddleware({
        getMailbox: (): MailboxComponent | undefined => attachedAgent?.component(MAILBOX),
        getInbox: (): InboxComponent | undefined => attachedAgent?.component(INBOX),
      }),
    );
  }

  if (parts.compactorMiddleware !== undefined) {
    middlewareList.push(parts.compactorMiddleware);
  }

  if (parts.collectiveMemoryMiddleware !== undefined) {
    middlewareList.push(parts.collectiveMemoryMiddleware);
  }

  if (parts.eventTraceMiddleware !== undefined) {
    middlewareList.push(parts.eventTraceMiddleware);
  }

  if (parts.reportMiddleware !== undefined) {
    middlewareList.push(parts.reportMiddleware);
  }

  if (parts.goalStackMiddleware !== undefined) {
    for (const mw of parts.goalStackMiddleware) {
      middlewareList.push(mw);
    }
  } else if (parts.taskBoardGoalStack === true) {
    // Auto-wire task-board reminders and drift detection into the goal stack.
    // Uses the harness's live task board as the snapshot source so reminders
    // always reflect the current state of pending/assigned tasks.
    const getTaskBoard = (): import("@koi/core").TaskBoardSnapshot =>
      parts.harness.status().taskBoard;
    const taskBoardGoalStack = createGoalStack({
      preset: "autonomous",
      reminder: {
        sources: [createTaskBoardSource(getTaskBoard)],
        isDrifting: createTaskAwareDrifting(getTaskBoard),
      },
    });
    for (const mw of taskBoardGoalStack.middlewares) {
      middlewareList.push(mw);
    }
  }

  // Auto-harness middleware — opt-in failure-driven middleware synthesis.
  // Created via createAutoHarnessStack() from @koi/auto-harness.
  if (parts.autoHarnessMiddleware !== undefined) {
    for (const mw of parts.autoHarnessMiddleware) {
      middlewareList.push(mw);
    }
  }

  const cachedMiddleware: readonly KoiMiddleware[] = middlewareList;

  // --- Build providers list ---
  const providerList: ComponentProvider[] = [];

  // Plan autonomous tool provider — always included for self-escalation.
  // When the agent creates a plan, start the harness with the task board
  // then start the scheduler so it begins auto-resuming sessions.
  // If the plan contains spawn-delegated tasks, create the delegation bridge
  // and dispatch root tasks immediately.
  providerList.push(
    createPlanAutonomousProvider({
      onPlanCreated: async (plan) => {
        process.stderr.write(
          `[autonomous] plan created — ${String(plan.items.length)} tasks, starting harness\n`,
        );

        // Fail-fast: spawn tasks require a bound spawn function
        if (hasSpawnTasks(plan) && parts.getSpawn?.() === undefined) {
          throw new Error(
            "Spawn delegation requested but no spawn function is available. " +
              'Use delegation: "self" or bind a spawn function via bindSpawn().',
          );
        }

        const startResult = await parts.harness.start(plan);
        if (!startResult.ok) {
          process.stderr.write(`[autonomous] harness start failed: ${startResult.error.message}\n`);
          return;
        }
        // Harness is now active. The copilot's current engine run continues —
        // the agent can start working on tasks in this same session using
        // task_complete. When the engine run ends, the CLI auto-pauses the
        // harness (active → suspended), then the scheduler picks it up and
        // resumes for subsequent sessions until all tasks are done.
        process.stderr.write("[autonomous] harness active — scheduler starting\n");
        parts.scheduler.start();

        // Dispatch ready spawn tasks via the delegation bridge.
        // Lazily create the bridge on first plan with spawn tasks.
        const spawn = parts.getSpawn?.();
        if (hasSpawnTasks(plan) && spawn !== undefined) {
          bridge = createDelegationBridge({ spawn });
          process.stderr.write(
            "[autonomous] delegation bridge created — dispatching spawn tasks\n",
          );
          await dispatchSpawnTasks(
            bridge,
            parts.harness.status().taskBoard,
            parts.harness,
            notifyTask,
          );
        }
      },
    }),
  );

  // Task tools provider — registers task_complete, task_status, task_synthesize,
  // task_update, task_review so the agent can manage autonomous plan execution.
  providerList.push({
    name: "task-tools-provider",
    attach: async (_agent: Agent): Promise<AttachResult> => {
      const allTools = createTaskTools({
        getTaskBoard: () => parts.harness.status().taskBoard,
        completeTask: async (tid: TaskItemId, output: string) => {
          const result = await parts.harness.completeTask(tid, {
            taskId: tid,
            output,
            durationMs: 0,
          });
          if (!result.ok) {
            throw new Error(`completeTask failed: ${result.error.message}`);
          }
          const board = parts.harness.status().taskBoard;
          const remaining = board.items.filter((i) => i.status !== "completed").length;
          process.stderr.write(
            `[autonomous] task_complete: ${tid} — ${String(remaining)} remaining\n`,
          );

          // Cascade: dispatch newly-unblocked spawn tasks after a self-delegated
          // task completes (e.g., task B depends on task A, A just finished).
          if (bridge !== undefined) {
            await dispatchSpawnTasks(bridge, board, parts.harness, notifyTask);
          }
        },
        updateTask: async () => {
          // Harness has no updateDescription method — no-op
        },
      });
      // Register all task tools: task_complete, task_status, task_update,
      // task_review, task_synthesize — the copilot needs all five to manage
      // plan execution, review worker output, and merge final results.
      const components = new Map<string, unknown>();
      for (const tool of allTools) {
        components.set(`tool:${tool.descriptor.name}`, tool);
      }
      return { components, skipped: [] };
    },
  });

  // Autonomous provider with inbox — when thread support enabled.
  // The attach() callback captures the agent reference so inbox middleware
  // getters can resolve MAILBOX/INBOX components after assembly.
  if (parts.threadStore !== undefined) {
    const innerProvider = createAutonomousProvider({
      createInbox: (policy?: InboxPolicy): InboxComponent => {
        // In-memory inbox; real implementations use createInboxQueue from @koi/engine
        // L3 cannot import from L1, so we provide a minimal in-memory implementation
        const items: import("@koi/core").InboxItem[] = [];
        return {
          drain: () => {
            const drained = [...items];
            items.length = 0;
            return drained;
          },
          peek: () => [...items],
          depth: () => items.length,
          push: (item) => {
            const defaultPolicy: InboxPolicy = {
              collectCap: 20,
              followupCap: 50,
              steerCap: 1,
            };
            const effectivePolicy = policy ?? parts.inboxPolicy ?? defaultPolicy;
            const modeCount = items.filter((i) => i.mode === item.mode).length;
            const cap =
              item.mode === "collect"
                ? effectivePolicy.collectCap
                : item.mode === "followup"
                  ? effectivePolicy.followupCap
                  : effectivePolicy.steerCap;
            if (modeCount >= cap) return false;
            items.push(item);
            return true;
          },
        };
      },
      inboxPolicy: parts.inboxPolicy,
    });

    // Wrap the inner provider to capture the agent reference at attach time.
    // Spread optional fields conditionally to satisfy exactOptionalPropertyTypes.
    const wrappedProvider: ComponentProvider = {
      name: innerProvider.name,
      ...(innerProvider.priority !== undefined ? { priority: innerProvider.priority } : {}),
      attach: async (agent: Agent) => {
        if (attachedAgent !== undefined && attachedAgent.pid.id !== agent.pid.id) {
          throw new Error(
            `Provider is single-agent; cannot attach agent ${agent.pid.id} while agent ${attachedAgent.pid.id} is attached.`,
          );
        }
        // Capture agent reference so inbox middleware getters can
        // resolve MAILBOX/INBOX components via agent.component()
        attachedAgent = agent;
        return innerProvider.attach(agent);
      },
      ...(innerProvider.detach !== undefined
        ? {
            detach: async (agent: Agent) => {
              attachedAgent = undefined;
              return innerProvider.detach?.(agent);
            },
          }
        : {
            detach: async () => {
              attachedAgent = undefined;
            },
          }),
      ...(innerProvider.watch !== undefined ? { watch: innerProvider.watch } : {}),
    };

    providerList.push(wrappedProvider);
  }

  const cachedProviders: readonly ComponentProvider[] = providerList;

  // --- Agent resolver: auto-create from forgeStore if not provided ---
  const resolvedAgentResolver: AgentResolver | undefined =
    parts.agentResolver ??
    (parts.forgeStore !== undefined
      ? createCatalogAgentResolver({ forgeStore: parts.forgeStore })
      : undefined);

  // --- API ---
  const middleware = (): readonly KoiMiddleware[] => cachedMiddleware;
  const providers = (): readonly ComponentProvider[] => cachedProviders;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    // Order: abort bridge (cancels in-flight spawns), then scheduler, then harness
    bridge?.abort();
    await parts.scheduler.dispose();
    await parts.harness.dispose();
  };

  return {
    harness: parts.harness,
    scheduler: parts.scheduler,
    middleware,
    providers,
    dispose,
    ...(resolvedAgentResolver !== undefined ? { agentResolver: resolvedAgentResolver } : {}),
  };
}
