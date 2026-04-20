export interface ReconnectController {
  readonly run: () => Promise<boolean>;
  readonly isRunning: () => boolean;
}

export interface ReconnectControllerOptions {
  readonly backoffMs?: readonly number[];
  readonly attempt: (attemptIndex: number) => Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [100, 400, 1600, 6400, 25000];

export function createReconnectController(
  options: ReconnectControllerOptions,
): ReconnectController {
  let inFlight: Promise<boolean> | null = null;
  const delays = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep =
    options.sleep ??
    (async (ms: number): Promise<void> => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    });

  async function runInternal(): Promise<boolean> {
    for (let index = 0; index < delays.length; index += 1) {
      if (index > 0) {
        await sleep(delays[index] ?? 0);
      }
      if (await options.attempt(index)) {
        return true;
      }
    }
    return false;
  }

  return {
    run(): Promise<boolean> {
      if (inFlight !== null) {
        return inFlight;
      }
      inFlight = runInternal().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    isRunning(): boolean {
      return inFlight !== null;
    },
  };
}
