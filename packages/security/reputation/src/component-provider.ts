/**
 * ComponentProvider that attaches a full ReputationBackend on the REPUTATION token.
 *
 * Agents receive both read and write access — they can record feedback and
 * query scores through the same component.
 */

import type { AttachResult, ComponentProvider, ReputationBackend } from "@koi/core";
import { COMPONENT_PRIORITY, REPUTATION } from "@koi/core";

/**
 * Create a ComponentProvider that attaches the given ReputationBackend
 * to every agent under the REPUTATION token.
 */
export function createReputationProvider(backend: ReputationBackend): ComponentProvider {
  const components: ReadonlyMap<string, unknown> = new Map([[REPUTATION as string, backend]]);
  const result: AttachResult = { components, skipped: [] };

  return {
    name: "reputation",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async () => result,
    detach: async () => {
      await backend.dispose?.();
    },
  };
}
