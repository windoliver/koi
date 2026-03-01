/**
 * AgentRegistry → ANS sync bridge.
 *
 * Listens to registry watch events and mirrors agent registrations/
 * deregistrations into the name service. Agent names are extracted
 * from `entry.metadata.name` (set during engine registration).
 */

import type {
  AgentId,
  AgentRegistry,
  ForgeScope,
  NameServiceWriter,
  RegistryEvent,
} from "@koi/core";

/** Configuration for registry sync. */
export interface RegistrySyncConfig {
  /** Default scope for auto-registered agent names. Defaults to "agent". */
  readonly defaultScope?: ForgeScope;
  /** Who to attribute auto-registrations to. Defaults to "registry-sync". */
  readonly registeredBy?: string;
}

/** Safely handle a possibly-async result, logging errors. */
function handleAsyncResult(result: unknown): void {
  if (result instanceof Promise) {
    result.catch((cause: unknown) => {
      // Best-effort sync — log and continue. The agent remains functional
      // without an ANS entry.
      console.error("[name-service] registry sync failed:", cause);
    });
  }
}

/**
 * Create a sync bridge that mirrors AgentRegistry events into the name service.
 *
 * On "registered" events: registers the agent name in ANS.
 * On "deregistered" events: unregisters the agent name from ANS.
 *
 * @param registry - The AgentRegistry to watch.
 * @param nameService - The NameServiceWriter to register/unregister names in.
 * @param config - Optional configuration.
 * @returns An unsubscribe function that stops the sync.
 */
export function createRegistrySync(
  registry: AgentRegistry,
  nameService: NameServiceWriter,
  config?: RegistrySyncConfig,
): () => void {
  const scope = config?.defaultScope ?? "agent";
  const registeredBy = config?.registeredBy ?? "registry-sync";

  // Track agentId → name mapping for deregistration
  const agentNames = new Map<AgentId, string>();

  const handleEvent = (event: RegistryEvent): void => {
    if (event.kind === "registered") {
      // Extract name from metadata, falling back to agentId
      const name =
        typeof event.entry.metadata.name === "string"
          ? event.entry.metadata.name
          : `${event.entry.agentId}`;

      agentNames.set(event.entry.agentId, name);

      handleAsyncResult(
        nameService.register({
          name,
          binding: { kind: "agent", agentId: event.entry.agentId },
          scope,
          registeredBy,
        }),
      );
    } else if (event.kind === "deregistered") {
      const name = agentNames.get(event.agentId);
      if (name !== undefined) {
        agentNames.delete(event.agentId);
        handleAsyncResult(nameService.unregister(name, scope));
      }
    }
    // "transitioned" events are ignored — name bindings don't change on state transitions
  };

  return registry.watch(handleEvent);
}
