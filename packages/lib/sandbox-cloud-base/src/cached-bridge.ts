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

interface Slot<TLease> {
  readonly lease: TLease;
  expiresAt: number;
  activeCount: number;
  pendingDispose: boolean;
  drainListeners: Array<() => void>;
}

function createDisposedError(): Error {
  return new Error("Cached bridge has been disposed");
}

export function createCachedBridge<
  TInput,
  TOutput,
  TLease extends CachedBridgeLease<TInput, TOutput> = CachedBridgeLease<TInput, TOutput>,
>(config: CachedBridgeConfig<TInput, TOutput, TLease>): CachedBridge<TInput, TOutput, TLease> {
  let slot: Slot<TLease> | undefined;
  let disposed = false;
  let inflight: Promise<Slot<TLease>> | undefined;
  let pendingCleanup: Promise<void> | undefined;
  const deferredCleanups = new Set<Promise<void>>();

  function isExpired(target: Slot<TLease>, now: number): boolean {
    return now >= target.expiresAt;
  }

  function notifyDrained(target: Slot<TLease>): void {
    if (target.activeCount !== 0) {
      return;
    }
    const listeners = target.drainListeners;
    target.drainListeners = [];
    for (const cb of listeners) {
      cb();
    }
  }

  function waitForDrain(target: Slot<TLease>): Promise<void> {
    if (target.activeCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      target.drainListeners.push(resolve);
    });
  }

  async function disposeLease(target: TLease): Promise<void> {
    await target.dispose();
  }

  async function runCleanup(target: TLease): Promise<void> {
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

  async function disposeWhenDrained(target: Slot<TLease>): Promise<void> {
    target.pendingDispose = true;
    if (target.activeCount === 0) {
      await runCleanup(target.lease);
      return;
    }
    await waitForDrain(target);
    await runCleanup(target.lease);
  }

  function detachExpiredSlot(): Slot<TLease> | undefined {
    if (slot === undefined) {
      return undefined;
    }
    if (!isExpired(slot, Date.now())) {
      return undefined;
    }
    const stale = slot;
    slot = undefined;
    return stale;
  }

  async function acquireSlot(): Promise<Slot<TLease>> {
    if (disposed) {
      throw createDisposedError();
    }

    if (slot !== undefined && !isExpired(slot, Date.now())) {
      return slot;
    }

    if (inflight === undefined) {
      inflight = (async () => {
        const stale = detachExpiredSlot();
        if (stale !== undefined) {
          if (stale.activeCount === 0) {
            await runCleanup(stale.lease);
          } else {
            // Defer disposal until in-flight executions drain so they don't get torn
            // down mid-call. New callers can proceed against a fresh lease meanwhile.
            // Track the cleanup promise so dispose() always awaits every detached
            // slot, even when several have accumulated concurrently.
            const deferred = disposeWhenDrained(stale).catch(() => undefined);
            deferredCleanups.add(deferred);
            void deferred.finally(() => deferredCleanups.delete(deferred));
          }
        }

        if (slot !== undefined) {
          return slot;
        }

        const nextLease = await config.acquire();
        if (disposed) {
          await runCleanup(nextLease);
          throw createDisposedError();
        }

        const newSlot: Slot<TLease> = {
          lease: nextLease,
          expiresAt: Date.now() + Math.max(0, config.ttlMs),
          activeCount: 0,
          pendingDispose: false,
          drainListeners: [],
        };
        slot = newSlot;
        return newSlot;
      })().finally(() => {
        inflight = undefined;
      });
    }

    return inflight;
  }

  async function warmup(): Promise<TLease> {
    const acquired = await acquireSlot();
    return acquired.lease;
  }

  function refreshExpiry(target: Slot<TLease>): void {
    if (target.pendingDispose) {
      return;
    }
    target.expiresAt = Date.now() + Math.max(0, config.ttlMs);
  }

  async function execute(input: TInput): Promise<TOutput> {
    const acquired = await acquireSlot();
    acquired.activeCount += 1;
    try {
      const value = await acquired.lease.execute(input);
      // Idle-TTL semantics: refresh the expiry on each successful use so
      // hot bridges aren't recycled mid-traffic. TTL applies only to
      // inactivity, not absolute lifetime.
      refreshExpiry(acquired);
      return value;
    } finally {
      acquired.activeCount -= 1;
      notifyDrained(acquired);
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;

    const currentInflight = inflight;
    if (currentInflight !== undefined) {
      await currentInflight.catch(() => undefined);
    }

    const current = slot;
    slot = undefined;
    if (current !== undefined) {
      await disposeWhenDrained(current);
    }

    if (pendingCleanup !== undefined) {
      await pendingCleanup;
    }

    // Wait for every previously-detached stale slot to finish its cleanup
    // before declaring disposal complete.
    while (deferredCleanups.size > 0) {
      await Promise.all(Array.from(deferredCleanups));
    }
  }

  return {
    warmup,
    getLease: () => {
      if (slot === undefined) {
        return undefined;
      }
      if (isExpired(slot, Date.now())) {
        return undefined;
      }
      return slot.lease;
    },
    execute,
    dispose,
  };
}
