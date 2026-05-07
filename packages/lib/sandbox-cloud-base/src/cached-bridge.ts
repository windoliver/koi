export interface CachedBridgeLease {
  readonly dispose: () => void | Promise<void>;
}

export interface CachedBridgeConfig<TLease extends CachedBridgeLease = CachedBridgeLease> {
  readonly acquire: () => Promise<TLease>;
}

export interface CachedBridge<TLease extends CachedBridgeLease = CachedBridgeLease> {
  readonly warmup: () => Promise<TLease>;
  readonly getLease: () => TLease | undefined;
  readonly dispose: () => Promise<void>;
}

export function createCachedBridge<TLease extends CachedBridgeLease>(
  config: CachedBridgeConfig<TLease>,
): CachedBridge<TLease> {
  let lease: TLease | undefined;
  let inflight: Promise<TLease> | undefined;
  let disposed = false;

  async function warmup(): Promise<TLease> {
    if (disposed) {
      throw new Error("Cached bridge has been disposed");
    }
    if (lease !== undefined) {
      return lease;
    }
    if (inflight === undefined) {
      inflight = config.acquire().then(
        async (nextLease) => {
          if (disposed) {
            await nextLease.dispose();
            throw new Error("Cached bridge has been disposed");
          }
          lease = nextLease;
          inflight = undefined;
          return nextLease;
        },
        (error: unknown) => {
          inflight = undefined;
          throw error;
        },
      );
    }
    return inflight;
  }

  async function dispose(): Promise<void> {
    disposed = true;
    const currentInflight = inflight;
    if (currentInflight !== undefined) {
      await currentInflight.catch(() => undefined);
    }

    const currentLease = lease;
    lease = undefined;
    inflight = undefined;
    if (currentLease !== undefined) {
      await currentLease.dispose();
    }
  }

  return {
    warmup,
    getLease: () => lease,
    dispose,
  };
}
