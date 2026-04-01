import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core";

export interface InMemoryStoreConfig {
  readonly maxSizeBytes?: number;
}

/**
 * In-memory `TrajectoryDocumentStore` for Phase 1 testing and development.
 * Backed by a simple Map. Not suitable for production persistence.
 */
export function createInMemoryTrajectoryStore(
  config?: InMemoryStoreConfig,
): TrajectoryDocumentStore {
  const docs = new Map<string, readonly RichTrajectoryStep[]>();
  const maxSize = config?.maxSizeBytes ?? Infinity;

  return {
    async append(docId, steps) {
      const existing = docs.get(docId) ?? [];
      let merged = [...existing, ...steps];

      // Prune oldest steps if over size budget
      while (merged.length > 1 && JSON.stringify(merged).length > maxSize) {
        merged = merged.slice(1);
      }

      docs.set(docId, merged);
    },

    async getDocument(docId) {
      return docs.get(docId) ?? [];
    },

    async getStepRange(docId, startIndex, endIndex) {
      const steps = docs.get(docId) ?? [];
      return steps.filter((s) => s.stepIndex >= startIndex && s.stepIndex < endIndex);
    },

    async getSize(docId) {
      const steps = docs.get(docId);
      if (!steps || steps.length === 0) return 0;
      return JSON.stringify(steps).length;
    },

    async prune(olderThanMs) {
      let pruned = 0;
      for (const [docId, steps] of docs) {
        const lastStep = steps[steps.length - 1];
        if (lastStep && lastStep.timestamp < olderThanMs) {
          pruned += steps.length;
          docs.delete(docId);
        }
      }
      return pruned;
    },
  };
}
