export type TabOwnership =
  | {
      readonly phase: "committed";
      readonly clientId: string;
      readonly sessionId: string;
      readonly committingRequestId: string;
      readonly since: number;
    }
  | {
      readonly phase: "detaching_failed";
      readonly clientId: string;
      readonly sessionId: string;
      readonly reason: string;
      readonly since: number;
    };

export interface OwnershipMap {
  readonly get: (tabId: number) => TabOwnership | undefined;
  readonly set: (tabId: number, entry: TabOwnership) => void;
  readonly delete: (tabId: number) => boolean;
  readonly entries: () => IterableIterator<readonly [number, TabOwnership]>;
  readonly size: () => number;
}

export function createOwnershipMap(): OwnershipMap {
  const map = new Map<number, TabOwnership>();
  return {
    get: (tabId) => map.get(tabId),
    set: (tabId, entry) => {
      map.set(tabId, entry);
    },
    delete: (tabId) => map.delete(tabId),
    entries: () => map.entries(),
    size: () => map.size,
  };
}
