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
  AgentResolver,
  ComponentProvider,
  HarnessThreadSnapshot,
  InboxComponent,
  InboxPolicy,
  KoiMiddleware,
  MailboxComponent,
  ThreadMetrics,
} from "@koi/core";
import { agentId, INBOX, MAILBOX, threadId } from "@koi/core";
import {
  createAutonomousProvider,
  createCheckpointMiddleware,
  createInboxMiddleware,
  createPlanAutonomousProvider,
} from "@koi/long-running";
import type { AutonomousAgent, AutonomousAgentParts } from "./types.js";

export function createAutonomousAgent(parts: AutonomousAgentParts): AutonomousAgent {
  // let justified: mutable disposal guard
  let disposed = false;

  // let justified: mutable agent reference — captured at attach time by
  // the autonomous-provider so inbox getters can resolve ECS components.
  // Undefined until the first provider.attach() fires during agent assembly.
  let attachedAgent: Agent | undefined;

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
  }

  const cachedMiddleware: readonly KoiMiddleware[] = middlewareList;

  // --- Build providers list ---
  const providerList: ComponentProvider[] = [];

  // Plan autonomous tool provider — always included for self-escalation.
  // When the agent creates a plan, start the scheduler so the harness
  // begins polling and auto-resuming sessions.
  providerList.push(
    createPlanAutonomousProvider({
      onPlanCreated: () => {
        parts.scheduler.start();
      },
    }),
  );

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
    // Order: dispose scheduler first (prevents new resumes), then dispose harness
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
