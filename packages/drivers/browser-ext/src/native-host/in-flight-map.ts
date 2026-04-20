export interface InFlightAttach {
  readonly tabId: number;
  readonly clientId: string;
  readonly attachRequestId: string;
  readonly receivedAt: number;
  abandoned: boolean;
}

function key(clientId: string, attachRequestId: string): string {
  return `${clientId}:${attachRequestId}`;
}

export interface InFlightMap {
  readonly add: (entry: InFlightAttach) => void;
  readonly get: (clientId: string, attachRequestId: string) => InFlightAttach | undefined;
  readonly delete: (clientId: string, attachRequestId: string) => boolean;
  readonly markAbandonedByClient: (clientId: string) => readonly InFlightAttach[];
  readonly entriesForTab: (tabId: number) => readonly InFlightAttach[];
  readonly findByTabAndRequest: (
    tabId: number,
    attachRequestId: string,
  ) => InFlightAttach | undefined;
  readonly size: () => number;
}

export function createInFlightMap(): InFlightMap {
  const map = new Map<string, InFlightAttach>();
  return {
    add: (entry) => {
      map.set(key(entry.clientId, entry.attachRequestId), entry);
    },
    get: (clientId, attachRequestId) => map.get(key(clientId, attachRequestId)),
    delete: (clientId, attachRequestId) => map.delete(key(clientId, attachRequestId)),
    markAbandonedByClient: (clientId) => {
      const affected: InFlightAttach[] = [];
      for (const entry of map.values()) {
        if (entry.clientId === clientId && !entry.abandoned) {
          entry.abandoned = true;
          affected.push(entry);
        }
      }
      return affected;
    },
    entriesForTab: (tabId) =>
      Array.from(map.values()).filter((e) => e.tabId === tabId && !e.abandoned),
    findByTabAndRequest: (tabId, attachRequestId) => {
      for (const entry of map.values()) {
        if (entry.tabId === tabId && entry.attachRequestId === attachRequestId) return entry;
      }
      return undefined;
    },
    size: () => map.size,
  };
}
