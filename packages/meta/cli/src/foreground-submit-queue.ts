export interface ForegroundSubmitQueueRunner {
  readonly run: (text: string) => Promise<void>;
  readonly interrupt?: (() => Promise<void> | void) | undefined;
}

export interface ForegroundSubmitQueueHooks {
  readonly onEnqueue?: ((text: string) => void) | undefined;
  readonly onDequeue?: ((text: string) => void) | undefined;
  readonly onClear?: ((texts: readonly string[]) => void) | undefined;
}

export interface ForegroundSubmitQueue {
  readonly submit: (text: string) => Promise<"started" | "queued">;
  readonly interruptAndSubmit: (text: string) => Promise<"started">;
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
  let activeRun: Promise<void> | null = null;
  let opTail = Promise.resolve();

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = opTail.then(work, work);
    opTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const runNext = async (text: string): Promise<void> => {
    running = true;
    const runPromise = (async () => {
      try {
        await runner.run(text);
      } finally {
        running = false;
        activeRun = null;
        const next = queued.shift();
        if (next !== undefined) {
          hooks.onDequeue?.(next);
          void runNext(next);
        }
      }
    })();
    activeRun = runPromise;
    await runPromise;
  };

  return {
    submit(text: string): Promise<"started" | "queued"> {
      return serialize(async () => {
        if (running) {
          queued.push(text);
          hooks.onEnqueue?.(text);
          return "queued";
        }
        void runNext(text);
        return "started";
      });
    },

    interruptAndSubmit(text: string): Promise<"started"> {
      return serialize(async () => {
        const cleared = [...queued];
        queued.length = 0;
        if (cleared.length > 0) {
          hooks.onClear?.(cleared);
        }
        if (running) {
          await runner.interrupt?.();
          try {
            await activeRun;
          } catch {
            // Active run errors surface through the normal UI path.
          }
        }
        void runNext(text);
        return "started" as const;
      });
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
