import type { AuditLog, DistillationRecord } from "./types.js";

export function createAuditLog(): AuditLog {
  const entries: DistillationRecord[] = [];
  return {
    record: (entry: DistillationRecord): void => {
      entries.push(entry);
    },
    list: (): readonly DistillationRecord[] => entries.slice(),
    clear: (): void => {
      entries.length = 0;
    },
  };
}
