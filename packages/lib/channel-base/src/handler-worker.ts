/**
 * @koi/channel-base — handler worker loop.
 *
 * Polls an IngressQueue, claims items, runs the user's async handler, and
 * commits + acks on success or aborts + nacks/dead-letters on failure.
 *
 * **Lease/claim model.** The queue claim and the idempotency lease are
 * BOTH taken with `leaseMs = handlerTimeoutMs + leaseGraceMs` (default
 * grace 5s) and never renewed. The grace buffer ensures the cleanup
 * paths (commit-as-tombstone + deadLetter) finish BEFORE the lease can
 * expire on the max-retry terminal branch.
 *
 * **Timeout policy.** The public MessageHandler contract is single-arg
 * (no AbortSignal), so a worker cannot reliably stop a handler that
 * ignores cancellation. Timeout therefore commits a POISON tombstone
 * and dead-letters the queue item: the original handler runs to
 * completion in the background (we cannot stop it) but no other
 * invocation occurs — future redelivery sees `poisoned` on tryBegin
 * and dead-letters the new item too. Drain-gated channels (email
 * IMAP) get a terminal awaitDrain outcome and can keep the source
 * message un-acked for operator triage. Without this terminal step,
 * the IMAP callback would wait forever on a hung handler and wedge
 * mailbox progress.
 *
 * There is deliberately NO mid-handler renewal:
 *
 *   - Renewal that can fail introduces an "ownership-lost" path where a
 *     successor worker may claim the same item while the original
 *     handler is still running. Channel adapters cannot guarantee the
 *     user's `MessageHandler` honours an `AbortSignal` (the public
 *     contract in `@koi/core` does not expose one), so concurrent
 *     execution under one ingress key cannot be safely reasoned about.
 *
 *   - Without renewal, the only way a successor sees the same item is
 *     after `handlerTimeoutMs` has elapsed — the same contract the
 *     handler-side timeout already imposes, applied uniformly.
 *
 * Operators that need stronger guarantees should provide an
 * `IdempotencyStore` whose `tryBegin` returns `committed` once the
 * handler's side effects are durably visible (e.g., a database row or
 * an outbound provider acknowledgement).
 */

import type { IdempotencyStore, Lease } from "./idempotency-store.js";
import type { IngressQueue } from "./ingress-queue.js";

export type HandlerInput<P, N> = {
  readonly key: string;
  readonly payload: P;
  readonly normalized: N;
};

/**
 * `signal` aborts when the handler exceeds `handlerTimeoutMs`. Handlers
 * SHOULD honour it; pure or naturally-idempotent handlers may ignore it.
 */
export type Handler<P, N> = (input: HandlerInput<P, N>, signal: AbortSignal) => Promise<void>;

export type HandlerWorkerOptions<P, N> = {
  readonly queue: IngressQueue<P, N>;
  readonly idempotencyStore: IdempotencyStore;
  readonly handler: Handler<P, N>;
  readonly commitTtlMs: number;
  readonly handlerTimeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly maxHandlerRetries?: number;
  readonly workerId: string;
  /**
   * Extra wall-clock buffer added to the queue claim and idempotency lease
   * on top of `handlerTimeoutMs`. The cleanup path that runs AFTER a handler
   * times out (commit-as-tombstone + deadLetter) must complete BEFORE the
   * lease expires and a successor worker reclaims the item. Without this
   * buffer, a slow store under load could let a successor see no live lease
   * and no committed tombstone, opening a window for concurrent re-execution
   * of a still-running handler. Default 5s is conservative for in-memory
   * stores; durable-store deployments should size this to p99 store latency.
   */
  readonly leaseGraceMs?: number;
};

const DEFAULT_LEASE_GRACE_MS = 5_000;

export function startHandlerWorker<P, N>(opts: HandlerWorkerOptions<P, N>): () => Promise<void> {
  // Lease > handler deadline. No renewal — see file header. The grace
  // buffer keeps the lease live long enough for the post-timeout cleanup
  // path (commit-as-tombstone + deadLetter) to run before a successor can
  // reclaim and re-execute concurrently.
  const leaseMs = opts.handlerTimeoutMs + (opts.leaseGraceMs ?? DEFAULT_LEASE_GRACE_MS);
  const pollMs = opts.pollIntervalMs ?? 250;
  const maxRetries = opts.maxHandlerRetries ?? 3;
  let stopped = false;

  const ctx: WorkerCtx<P, N> = { opts, leaseMs, maxRetries };
  const loop = async (): Promise<void> => {
    while (!stopped) {
      const claimed = await opts.queue.claim(opts.workerId, leaseMs);
      if (!claimed) {
        await sleep(pollMs);
        continue;
      }
      await processClaim(ctx, claimed);
      // Cooperative yield: every iteration ends in a setTimeout(0) so a tight
      // nack-only path (e.g. capacity-exhausted, or a poison-replay drain
      // storm) cannot starve macrotasks. Without this, callers that race
      // against the loop with their own setTimeout-based wait can stall
      // because the microtask queue never empties.
      await sleep(0);
    }
  };

  const running = loop();
  return async () => {
    stopped = true;
    await running.catch(() => {});
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type TimeoutResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly timedOut: boolean; readonly error: Error };

function runWithTimeout<T>(
  p: Promise<T>,
  ms: number,
  ctl: AbortController,
): Promise<TimeoutResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: TimeoutResult<T>): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const t = setTimeout(() => {
      const err = new Error(`handler timeout after ${ms}ms`);
      ctl.abort(err);
      settle({ ok: false, timedOut: true, error: err });
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        settle({ ok: true, value: v });
      },
      (e: unknown) => {
        clearTimeout(t);
        settle({
          ok: false,
          timedOut: false,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      },
    );
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function commitPoisonDurably(
  store: IdempotencyStore,
  lease: Lease,
  commitTtlMs: number,
): Promise<boolean> {
  try {
    await store.commitPoison(lease, commitTtlMs);
    return true;
  } catch {
    return false;
  }
}

type WorkerCtx<P, N> = {
  readonly opts: HandlerWorkerOptions<P, N>;
  readonly leaseMs: number;
  readonly maxRetries: number;
};

async function processClaim<P, N>(
  ctx: WorkerCtx<P, N>,
  claimed: {
    readonly key: string;
    readonly payload: P;
    readonly normalized: N;
    readonly attempts: number;
  },
): Promise<void> {
  const { opts, leaseMs } = ctx;
  const begin = await opts.idempotencyStore.tryBegin(claimed.key, leaseMs);
  if (!begin.ok) {
    await handleBeginFailure(opts, claimed.key, begin.reason);
    return;
  }
  const ctl = new AbortController();
  try {
    const r = await runWithTimeout(
      opts.handler(
        { key: claimed.key, payload: claimed.payload, normalized: claimed.normalized },
        ctl.signal,
      ),
      opts.handlerTimeoutMs,
      ctl,
    );
    if (!r.ok) {
      if (r.timedOut) {
        await handleTimeout(opts, claimed.key, begin.lease, r.error);
        return;
      }
      throw r.error;
    }
    await opts.idempotencyStore.commit(begin.lease, opts.commitTtlMs);
    await opts.queue.ack(opts.workerId, claimed.key);
  } catch (e) {
    await handleHandlerError(ctx, claimed.key, claimed.attempts, begin.lease, e);
  }
}

async function handleBeginFailure<P, N>(
  opts: HandlerWorkerOptions<P, N>,
  key: string,
  reason: "committed" | "in-flight" | "capacity-exhausted" | "poisoned",
): Promise<void> {
  if (reason === "committed") {
    await opts.queue.ack(opts.workerId, key);
  } else if (reason === "poisoned") {
    await opts.queue.deadLetter(opts.workerId, key, "poisoned-key-replay");
  } else {
    // in-flight or capacity-exhausted: nack (no terminal deadLetter for
    // capacity to avoid redelivery storms; in-flight is naturally transient).
    await opts.queue.nack(opts.workerId, key);
  }
}

async function handleTimeout<P, N>(
  opts: HandlerWorkerOptions<P, N>,
  key: string,
  lease: Lease,
  error: Error,
): Promise<void> {
  // Commit POISON tombstone so future redelivery sees `poisoned` and is
  // dead-lettered. DeadLetter unconditionally so drain-gated channels
  // (email IMAP awaitDrain) get a terminal outcome and don't wedge.
  const poisonOk = await commitPoisonDurably(opts.idempotencyStore, lease, opts.commitTtlMs);
  const reason = poisonOk
    ? `handler-timeout: ${error.message}`
    : `handler-timeout (poison-commit-failed): ${error.message}`;
  await opts.queue.deadLetter(opts.workerId, key, reason);
}

async function handleHandlerError<P, N>(
  ctx: WorkerCtx<P, N>,
  key: string,
  attempts: number,
  lease: Lease,
  e: unknown,
): Promise<void> {
  const { opts, maxRetries } = ctx;
  if (attempts + 1 < maxRetries) {
    await opts.idempotencyStore.abort(lease).catch(() => {});
    await opts.queue.nack(opts.workerId, key);
    return;
  }
  // Terminal: poison must land before deadLetter; if it fails, fall back to
  // nack so a redelivery cannot find a brand-new key and re-run.
  const poisonOk = await commitPoisonDurably(opts.idempotencyStore, lease, opts.commitTtlMs);
  if (poisonOk) {
    await opts.queue.deadLetter(opts.workerId, key, errorMessage(e));
  } else {
    await opts.idempotencyStore.abort(lease).catch(() => {});
    await opts.queue.nack(opts.workerId, key);
  }
}
