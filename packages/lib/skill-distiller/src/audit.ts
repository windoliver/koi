import type { AuditLog, DistillationRecord } from "./types.js";

// Deep-freeze recursively so callers cannot mutate audit history through any
// shared object reference. TypeScript `readonly` is erased at runtime.
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function createAuditLog(): AuditLog {
  const entries: DistillationRecord[] = [];
  return {
    record: (entry: DistillationRecord): void => {
      entries.push(deepFreeze(entry));
    },
    list: (): readonly DistillationRecord[] => entries.slice(),
    clear: (): void => {
      entries.length = 0;
    },
  };
}
