import { deepFreeze } from "./freeze.js";
import type { AuditLog, DistillationRecord } from "./types.js";

export function createAuditLog(): AuditLog {
  const entries: DistillationRecord[] = [];
  return {
    record: (entry: DistillationRecord): void => {
      // Clone before freezing so the audit copy is independent of the caller's
      // reference — callers retain their original mutable record.
      entries.push(deepFreeze(structuredClone(entry)));
    },
    list: (): readonly DistillationRecord[] => entries.slice(),
    clear: (): void => {
      entries.length = 0;
    },
  };
}
