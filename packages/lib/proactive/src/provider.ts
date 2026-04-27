/**
 * ComponentProvider that wires the proactive tools onto the assembling agent.
 *
 * Unlike a static tool provider, we resolve the `SCHEDULER` component from
 * the agent at `attach` time. This guarantees each attached agent gets a
 * tool closure pinned to its own scheduler — never another agent's. Sharing
 * a single `ProactiveToolsProvider` instance across agents is therefore safe.
 */

import type { Agent, AttachResult, ComponentProvider, SkippedComponent, Tool } from "@koi/core";
import { COMPONENT_PRIORITY, SCHEDULER, toolToken } from "@koi/core";
import { createProactiveTools } from "./create-proactive-tools.js";
import type { ProactiveToolsConfig, ProactiveToolsProviderConfig } from "./types.js";

export function createProactiveToolsProvider(
  config: ProactiveToolsProviderConfig = {},
): ComponentProvider {
  const priority = config.priority ?? COMPONENT_PRIORITY.BUNDLED;

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

      const tools = createProactiveTools(toolConfig);
      const entries: (readonly [string, Tool])[] = tools.map(
        (t) => [toolToken(t.descriptor.name) as string, t] as const,
      );

      return { components: new Map(entries), skipped };
    },
  };
}
