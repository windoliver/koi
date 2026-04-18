export interface ForegroundSubmitQueueRunner {
  readonly run: (text: string) => Promise<void>;
}

export interface ForegroundSubmitQueueHooks {
  readonly onEnqueue?: ((text: string) => void) | undefined;
  readonly onDequeue?: ((text: string) => void) | undefined;
  readonly onClear?: ((texts: readonly string[]) => void) | undefined;
}

export interface ForegroundSubmitQueue {
  readonly submit: (text: string) => Promise<"started" | "queued">;
  readonly clear: () => readonly string[];
  readonly snapshot: () => readonly string[];
  readonly isRunning: () => boolean;
}

/**
 * Serializes foreground submits so mid-turn messages are preserved and
 * replayed FIFO after the active run settles.
 */
export function createForegroundSubmitQueue(
  runner: ForegroundSubmitQueueRunner,
  hooks: ForegroundSubmitQueueHooks = {},
): ForegroundSubmitQueue {
  const queued: string[] = [];
  let running = false;

  const runNext = async (text: string): Promise<void> => {
    running = true;
    try {
      await runner.run(text);
    } finally {
      running = false;
      const next = queued.shift();
      if (next !== undefined) {
        hooks.onDequeue?.(next);
        void runNext(next);
      }
    }
  };

  return {
    async submit(text: string): Promise<"started" | "queued"> {
      if (running) {
        queued.push(text);
        hooks.onEnqueue?.(text);
        return "queued";
      }
      void runNext(text);
      return "started";
    },

    clear(): readonly string[] {
      const cleared = [...queued];
      queued.length = 0;
      if (cleared.length > 0) {
        hooks.onClear?.(cleared);
      }
      return cleared;
    },

    snapshot(): readonly string[] {
      return [...queued];
    },

    isRunning(): boolean {
      return running;
    },
  };
}
