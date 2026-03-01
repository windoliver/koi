/**
 * ECS ComponentProvider for the Agent Name Service.
 *
 * Exposes a reader-only view of the NameServiceBackend as the
 * NAME_SERVICE component on each agent. Agents can resolve names
 * but cannot register or unregister.
 */

import type {
  AttachResult,
  ComponentProvider,
  NameChangeEvent,
  NameServiceBackend,
  NameServiceReader,
} from "@koi/core";
import { COMPONENT_PRIORITY, NAME_SERVICE } from "@koi/core";

/**
 * Create a reader-only view of the backend.
 * Strips register, unregister, renew, and dispose from the surface.
 */
function createReaderView(backend: NameServiceBackend): NameServiceReader {
  // Capture onChange before closure to narrow type without non-null assertion
  const onChangeFn = backend.onChange;
  return {
    resolve: (name, scope) => backend.resolve(name, scope),
    search: (query) => backend.search(query),
    suggest: (name, scope) => backend.suggest(name, scope),
    ...(onChangeFn !== undefined
      ? { onChange: (listener: (event: NameChangeEvent) => void) => onChangeFn(listener) }
      : {}),
  };
}

/**
 * Create a ComponentProvider that attaches a read-only NameServiceReader
 * as the NAME_SERVICE component on every agent.
 *
 * @param backend - The full name service backend (read + write).
 */
export function createNameServiceProvider(backend: NameServiceBackend): ComponentProvider {
  const readerView = createReaderView(backend);

  const components: ReadonlyMap<string, unknown> = new Map([[NAME_SERVICE as string, readerView]]);

  const result: AttachResult = {
    components,
    skipped: [],
  };

  return {
    name: "name-service",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async () => result,
  };
}
