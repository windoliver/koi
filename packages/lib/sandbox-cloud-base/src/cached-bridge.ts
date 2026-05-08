export interface CachedBridgeLease<TInput = unknown, TOutput = unknown> {
  readonly execute: (input: TInput) => Promise<TOutput>;
  readonly dispose: () => void | Promise<void>;
}

export interface CachedBridgeConfig<
  TInput = unknown,
  TOutput = unknown,
  TLease extends CachedBridgeLease<TInput, TOutput> = CachedBridgeLease<TInput, TOutput>,
> {
  readonly ttlMs: number;
  readonly acquire: () => Promise<TLease>;
}

export interface CachedBridge<
  TInput = unknown,
  TOutput = unknown,
  TLease extends CachedBridgeLease<TInput, TOutput> = CachedBridgeLease<TInput, TOutput>,
> {
  readonly warmup: () => Promise<TLease>;
  readonly getLease: () => TLease | undefined;
  readonly execute: (input: TInput) => Promise<TOutput>;
  readonly dispose: () => Promise<void>;
}

function createDisposedError(): Error {
  return new Error("Cached bridge has been disposed");
}

export function createCachedBridge<
  TInput,
  TOutput,
  TLease extends CachedBridgeLease<TInput, TOutput> = CachedBridgeLease<TInput, TOutput>,
>(config: CachedBridgeConfig<TInput, TOutput, TLease>): CachedBridge<TInput, TOutput, TLease> {
  let lease: TLease | undefined;
  let expiresAt = 0;
  let disposed = false;
  let inflight: Promise<TLease> | undefined;
  let pendingCleanup: Promise<void> | undefined;

  function isExpired(now: number): boolean {
    return lease !== undefined && now >= expiresAt;
  }

  async function disposeLease(target: TLease | undefined): Promise<void> {
    if (target === undefined) {
      return;
    }
    await target.dispose();
  }

  async function runCleanup(target: TLease | undefined): Promise<void> {
    const cleanup = disposeLease(target);
    pendingCleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (pendingCleanup === cleanup) {
        pendingCleanup = undefined;
      }
    }
  }

  async function warmup(): Promise<TLease> {
    if (disposed) {
      throw createDisposedError();
    }

    if (lease !== undefined && !isExpired(Date.now())) {
      return lease;
    }

    if (inflight === undefined) {
      inflight = (async () => {
        if (lease !== undefined && isExpired(Date.now())) {
          const expiredLease = lease;
          lease = undefined;
          expiresAt = 0;
          await runCleanup(expiredLease);
        }

        if (lease !== undefined) {
          return lease;
        }

        if (pendingCleanup !== undefined) {
          await pendingCleanup;
        }

        const nextLease = await config.acquire();
        if (disposed) {
          await runCleanup(nextLease);
          throw createDisposedError();
        }

        lease = nextLease;
        expiresAt = Date.now() + Math.max(0, config.ttlMs);
        return nextLease;
      })().finally(() => {
        inflight = undefined;
      });
    }

    return inflight;
  }

  async function execute(input: TInput): Promise<TOutput> {
    const activeLease = await warmup();
    return activeLease.execute(input);
  }

  async function dispose(): Promise<void> {
    disposed = true;

    const currentInflight = inflight;
    if (currentInflight !== undefined) {
      await currentInflight.catch(() => undefined);
    }

    const currentLease = lease;
    lease = undefined;
    expiresAt = 0;
    await runCleanup(currentLease);

    if (pendingCleanup !== undefined) {
      await pendingCleanup;
    }
  }

  return {
    warmup,
    getLease: () => {
      if (lease === undefined) {
        return undefined;
      }
      if (isExpired(Date.now())) {
        return undefined;
      }
      return lease;
    },
    execute,
    dispose,
  };
}
