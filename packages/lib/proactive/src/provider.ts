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
 * Sleep state is provider-scoped and keyed by `agent.pid.id` — it survives
 * reattach within the same process so a retry with the same idempotency_key
 * reuses the prior reservation. Stale entries are reconciled against the
 * scheduler's live view via `scheduler.query` on each call.
 *
 * Cron state is created **fresh on every attach**. `SchedulerComponent` has
 * no `querySchedules`, so we cannot reconcile cron entries against a live
 * backend. Persisting cron state across attaches would either return stale
 * `deduped:true` (after a real backend swap) or double-register (after a
 * wrapper swap on a shared backend). Re-creating cron state per attach
 * sidesteps both: same-attach retries dedupe; cross-attach retries register
 * fresh against the current backend, which is the safe direction. Cron is
 * typically registered once per agent so this rarely matters in practice.
 */

import type {
  Agent,
  AttachResult,
  ChannelAdapter,
  ComponentProvider,
  SkippedComponent,
  Tool,
} from "@koi/core";
import { COMPONENT_PRIORITY, channelToken, SCHEDULER, toolToken } from "@koi/core";
import { assembleProactiveTools } from "./create-proactive-tools.js";
import { createCronToolState } from "./cron-tools.js";
import { createMonitorToolState } from "./monitor-tools.js";
import { createSleepToolState, type SleepToolState } from "./sleep-tool.js";
import type { ProactiveToolsConfig, ProactiveToolsProviderConfig } from "./types.js";

export function createProactiveToolsProvider(
  config: ProactiveToolsProviderConfig = {},
): ComponentProvider {
  const priority = config.priority ?? COMPONENT_PRIORITY.BUNDLED;
  // Sleep state is provider-scoped per agent (see file header).
  const sleepSlots = new Map<string, SleepToolState>();

  function getSleepState(pid: string): SleepToolState {
    const existing = sleepSlots.get(pid);
    if (existing !== undefined) return existing;
    const fresh = createSleepToolState();
    sleepSlots.set(pid, fresh);
    return fresh;
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

      // Snapshot channel:* components at attach time. Channels added or
      // removed after attach are not reflected by `notify` until reattach —
      // matches the provider's existing per-attach lifecycle.
      const channelSnapshot = new Map<string, ChannelAdapter>();
      for (const key of agent.components().keys()) {
        if (!key.startsWith("channel:")) continue;
        const name = key.slice("channel:".length);
        const adapter = agent.component(channelToken(name));
        if (adapter !== undefined) channelSnapshot.set(name, adapter);
      }

      const toolConfig: ProactiveToolsConfig = {
        scheduler,
        agentId: agent.pid.id,
        ...(config.defaultWakeMessage !== undefined
          ? { defaultWakeMessage: config.defaultWakeMessage }
          : {}),
        ...(config.maxSleepMs !== undefined ? { maxSleepMs: config.maxSleepMs } : {}),
        ...(config.now !== undefined ? { now: config.now } : {}),
        ...(channelSnapshot.size > 0
          ? {
              resolveChannel: (n: string) => channelSnapshot.get(n),
              channelNames: () => [...channelSnapshot.keys()],
            }
          : {}),
      };

      // ProcessId is an object — slot by its `.id` (branded AgentId, a
      // string under the brand) so each agent gets its own slot. Stringifying
      // the whole ProcessId would yield "[object Object]" and collapse every
      // agent into a single shared slot, leaking idempotency state across
      // agents and silently dropping wake-ups.
      const sleepState = getSleepState(String(agent.pid.id));
      // Cron state is intentionally per-attach (see file header). Late
      // submissions from a previous attach land on the prior, now-detached
      // state object and have no observable effect on the new attach.
      const cronState = createCronToolState();
      // Monitor state is also intentionally per-attach: monitor metadata is
      // process-local and should reset when the agent is reassembled.
      const monitorState = createMonitorToolState();
      const tools = assembleProactiveTools(toolConfig, { sleepState, cronState, monitorState });
      const entries: (readonly [string, Tool])[] = tools.map(
        (t) => [toolToken(t.descriptor.name) as string, t] as const,
      );

      return { components: new Map(entries), skipped };
    },
  };
}
