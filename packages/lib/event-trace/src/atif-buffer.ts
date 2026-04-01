import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core";

export interface WriteBehindBufferConfig {
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly onFlushError?: (error: unknown, docId: string) => void;
}

export interface AtifWriteBehindBuffer {
  readonly append: (docId: string, step: RichTrajectoryStep) => void;
  readonly flush: (docId?: string) => Promise<void>;
  readonly pending: (docId: string) => number;
  readonly dispose: () => void;
}

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

export function createWriteBehindBuffer(
  store: TrajectoryDocumentStore,
  config?: WriteBehindBufferConfig,
): AtifWriteBehindBuffer {
  const batchSize = config?.batchSize ?? DEFAULT_BATCH_SIZE;
  const onError = config?.onFlushError ?? (() => {});
  const buffers = new Map<string, RichTrajectoryStep[]>();

  async function flushDoc(docId: string): Promise<void> {
    const steps = buffers.get(docId);
    if (!steps || steps.length === 0) return;
    // Clear buffer before async write to prevent race
    const batch = [...steps];
    steps.length = 0;
    try {
      await store.append(docId, batch);
    } catch (err: unknown) {
      onError(err, docId);
    }
  }

  async function flushAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const docId of buffers.keys()) {
      promises.push(flushDoc(docId));
    }
    await Promise.all(promises);
  }

  const timer = setInterval(() => {
    void flushAll();
  }, config?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);

  return {
    append(docId, step) {
      let buf = buffers.get(docId);
      if (!buf) {
        buf = [];
        buffers.set(docId, buf);
      }
      buf.push(step);
      if (buf.length >= batchSize) {
        void flushDoc(docId);
      }
    },

    async flush(docId?) {
      if (docId !== undefined) {
        await flushDoc(docId);
      } else {
        await flushAll();
      }
    },

    pending(docId) {
      return buffers.get(docId)?.length ?? 0;
    },

    dispose() {
      clearInterval(timer);
    },
  };
}
