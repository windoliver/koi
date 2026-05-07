import type { AgentMessage } from "@koi/core";

export interface SeenSet {
  readonly has: (id: string) => boolean;
  readonly add: (message: AgentMessage) => void;
  readonly drain: () => readonly AgentMessage[];
}

export function createSeenSet(): SeenSet {
  const ids = new Set<string>();
  let buffered: readonly AgentMessage[] = [];

  return {
    has: (id) => ids.has(id),
    add: (message) => {
      ids.add(message.id as string);
      buffered = [...buffered, message];
    },
    drain: () => {
      const snapshot = buffered;
      buffered = [];
      return snapshot;
    },
  };
}
