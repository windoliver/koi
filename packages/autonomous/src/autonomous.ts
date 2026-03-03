/**
 * Autonomous agent factory — composes harness + scheduler + optional compactor
 * into a coordinated autonomous agent with checkpoint/inbox support.
 *
 * Disposal order: stop scheduler first (prevents new resumes), then dispose harness.
 */

import type { ComponentProvider, InboxComponent, KoiMiddleware } from "@koi/core";
import {
  createAutonomousProvider,
  createCheckpointMiddleware,
  createInboxMiddleware,
  createPlanAutonomousProvider,
} from "@koi/long-running";
import { createHarnessHandoffBridge } from "./bridge.js";
import type { AutonomousAgent, AutonomousAgentParts, HarnessHandoffBridge } from "./types.js";

export function createAutonomousAgent(parts: AutonomousAgentParts): AutonomousAgent {
  // let justified: mutable disposal guard
  let disposed = false;

  // --- Build middleware list ---
  const middlewareList: KoiMiddleware[] = [parts.harness.createMiddleware()];

  // Checkpoint middleware — only when threadStore provided
  if (parts.threadStore !== undefined) {
    middlewareList.push(
      createCheckpointMiddleware({
        policy: parts.checkpointPolicy,
        onCheckpoint: async (ctx) => {
          // Checkpoint callback — persists current state via threadStore
          // In a full implementation, this would call threadStore.appendAndCheckpoint
          // For now, checkpoint is a no-op hook point for callers to override
          void ctx;
        },
      }),
    );
  }

  // Inbox middleware — routes mailbox messages to inbox queue
  if (parts.threadStore !== undefined) {
    middlewareList.push(
      createInboxMiddleware({
        getMailbox: () => undefined, // Wired at assembly time via agent.component(MAILBOX)
        getInbox: () => undefined, // Wired at assembly time via agent.component(INBOX)
      }),
    );
  }

  if (parts.compactorMiddleware !== undefined) {
    middlewareList.push(parts.compactorMiddleware);
  }

  const cachedMiddleware: readonly KoiMiddleware[] = middlewareList;

  // --- Build providers list ---
  const providerList: ComponentProvider[] = [];

  // Plan autonomous tool provider — always included for self-escalation
  providerList.push(
    createPlanAutonomousProvider({
      onPlanCreated: () => {
        // Hook point: callers can override to start autonomous execution
      },
    }),
  );

  // Autonomous provider with inbox — when thread support enabled
  if (parts.threadStore !== undefined) {
    providerList.push(
      createAutonomousProvider({
        createInbox: (): InboxComponent => {
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
              const policy = parts.inboxPolicy ?? { collectCap: 20, followupCap: 50, steerCap: 1 };
              const modeCount = items.filter((i) => i.mode === item.mode).length;
              const cap =
                item.mode === "collect"
                  ? policy.collectCap
                  : item.mode === "followup"
                    ? policy.followupCap
                    : policy.steerCap;
              if (modeCount >= cap) return false;
              items.push(item);
              return true;
            },
          };
        },
        inboxPolicy: parts.inboxPolicy,
      }),
    );
  }

  const cachedProviders: readonly ComponentProvider[] = providerList;

  // --- Optional bridge ---
  const handoffBridge: HarnessHandoffBridge | undefined =
    parts.handoffBridge !== undefined
      ? createHarnessHandoffBridge(parts.harness, parts.handoffBridge)
      : undefined;

  // --- API ---
  const middleware = (): readonly KoiMiddleware[] => cachedMiddleware;
  const providers = (): readonly ComponentProvider[] => cachedProviders;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    // Order: stop scheduler first (prevents new resumes), then dispose harness
    await parts.scheduler.dispose();
    await parts.harness.dispose();
  };

  return {
    harness: parts.harness,
    scheduler: parts.scheduler,
    middleware,
    providers,
    dispose,
    ...(handoffBridge !== undefined ? { handoffBridge } : {}),
  };
}
