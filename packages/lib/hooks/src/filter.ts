/**
 * Hook filter matching — determines whether a hook should fire for a given event.
 *
 * All specified filter fields must match (AND logic).
 * Within a field, any value can match (OR logic).
 * When no filter is set, the hook matches all events.
 */

import type { HookEvent, HookFilter } from "@koi/core";

/**
 * Returns true if the given event matches the hook filter.
 *
 * @param filter - The hook's filter config. When undefined, matches everything.
 * @param event - The event to test against.
 */
export function matchesHookFilter(filter: HookFilter | undefined, event: HookEvent): boolean {
  if (filter === undefined) {
    return true;
  }

  // Events filter: at least one event kind must match
  if (filter.events !== undefined && filter.events.length > 0) {
    if (!filter.events.includes(event.event)) {
      return false;
    }
  }

  // Tools filter: tool name must be present and match
  if (filter.tools !== undefined && filter.tools.length > 0) {
    if (event.toolName === undefined || !filter.tools.includes(event.toolName)) {
      return false;
    }
  }

  // Channels filter: channel ID must be present and match
  if (filter.channels !== undefined && filter.channels.length > 0) {
    if (event.channelId === undefined || !filter.channels.includes(event.channelId)) {
      return false;
    }
  }

  return true;
}
