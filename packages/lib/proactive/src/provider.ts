/**
 * ComponentProvider that wires the proactive tools onto the assembling agent.
 *
 * Per-agent scheduler resolution
 * ------------------------------
 * Unlike a static tool provider, we resolve the `SCHEDULER` component from
 * the agent at `attach` time. This guarantees each attached agent gets a
 * tool closure pinned to its own scheduler — never another agent's. Sharing
 * a single `ProactiveToolsProvider` instance across agents is therefore safe.
 *
 * Idempotency state lifetime
 * --------------------------
 * The cron and sleep idempotency maps are created **once per provider** and
 * keyed by `agent.pid` so each attached agent gets its own slot but the slot
 * survives across reattach (e.g. transient failure, agent reassembly between
 * turns). If the maps were created per-attach, a retry after reattach would
 * miss the prior reservation and register a duplicate.
 */

import type { Agent, AttachResult, ComponentProvider, SkippedComponent, Tool } from "@koi/core";
import { COMPONENT_PRIORITY, SCHEDULER, toolToken } from "@koi/core";
import { createCancelSleepTool } from "./cancel-sleep-tool.js";
import {
  type CronToolState,
  createCancelScheduleTool,
  createCronToolState,
  createScheduleCronTool,
} from "./cron-tools.js";
import { createSleepTool, createSleepToolState, type SleepToolState } from "./sleep-tool.js";
import type { ProactiveToolsConfig, ProactiveToolsProviderConfig } from "./types.js";

interface AgentStateSlot {
  readonly cron: CronToolState;
  readonly sleep: SleepToolState;
}

export function createProactiveToolsProvider(
  config: ProactiveToolsProviderConfig = {},
): ComponentProvider {
  const priority = config.priority ?? COMPONENT_PRIORITY.BUNDLED;
  // State lives at provider scope, keyed by stable agent identity (pid).
  // This survives reattach within the same process so a retry with the
  // same idempotency_key reuses the prior reservation.
  const slots = new Map<string, AgentStateSlot>();

  function getSlot(pid: string): AgentStateSlot {
    const existing = slots.get(pid);
    if (existing !== undefined) return existing;
    const fresh: AgentStateSlot = {
      cron: createCronToolState(),
      sleep: createSleepToolState(),
    };
    slots.set(pid, fresh);
    return fresh;
  }

  function buildTools(toolConfig: ProactiveToolsConfig, slot: AgentStateSlot): readonly Tool[] {
    return [
      createSleepTool(toolConfig, slot.sleep),
      createCancelSleepTool(toolConfig, slot.sleep),
      createScheduleCronTool(toolConfig, slot.cron),
      createCancelScheduleTool(toolConfig, slot.cron),
    ];
  }

  return {
    name: "proactive",
    priority,

    async attach(agent: Agent): Promise<AttachResult> {
      const scheduler = agent.component(SCHEDULER);
      const skipped: SkippedComponent[] = [];

      if (scheduler === undefined) {
        // No scheduler attached — proactive tools cannot operate. Surface this
        // explicitly rather than installing tools that would fail at call time.
        return {
          components: new Map(),
          skipped: [
            {
              name: "proactive",
              reason:
                "SchedulerComponent not attached to agent — install @koi/scheduler before @koi/proactive",
            },
          ],
        };
      }

      const toolConfig: ProactiveToolsConfig = {
        scheduler,
        ...(config.defaultWakeMessage !== undefined
          ? { defaultWakeMessage: config.defaultWakeMessage }
          : {}),
        ...(config.maxSleepMs !== undefined ? { maxSleepMs: config.maxSleepMs } : {}),
        ...(config.now !== undefined ? { now: config.now } : {}),
      };

      // ProcessId is an object — slot by its `.id` (branded AgentId, a
      // string under the brand) so each agent gets its own slot. Stringifying
      // the whole ProcessId would yield "[object Object]" and collapse every
      // agent into a single shared slot, leaking idempotency state across
      // agents and silently dropping wake-ups.
      const slot = getSlot(String(agent.pid.id));
      const tools = buildTools(toolConfig, slot);
      const entries: (readonly [string, Tool])[] = tools.map(
        (t) => [toolToken(t.descriptor.name) as string, t] as const,
      );

      return { components: new Map(entries), skipped };
    },
  };
}
