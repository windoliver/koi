/**
 * Optimized sync filter for Matrix client.
 *
 * Limits timeline events and filters out presence updates
 * to reduce bandwidth and processing overhead.
 */

/**
 * Returns a sync filter object that limits timeline to recent events
 * and excludes presence updates.
 */
export function createSyncFilter(): Record<string, unknown> {
  return {
    room: {
      timeline: {
        limit: 10,
      },
      state: {
        types: ["m.room.message", "m.room.member"],
      },
    },
    presence: {
      not_types: ["*"],
    },
  };
}
