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
 * ignores cancellation. Timeouts therefore abort the lease and nack
 * the queue item (transient retry), NEVER dead-letter or commit a
 * poison tombstone. Declaring terminal failure while the original
 * handler may still complete would let operators replay/compensate
 * AND have the original handler emit the same side effects later.
 * The max-retries path remains terminal (poison tombstone + dead-
 * letter): an explicitly-thrown failure is something the handler
 * decided to surface, distinct from a wall-clock-only timeout.
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

  const loop = async (): Promise<void> => {
    while (!stopped) {
      const claimed = await opts.queue.claim(opts.workerId, leaseMs);
      if (!claimed) {
        await sleep(pollMs);
        continue;
      }
      const begin = await opts.idempotencyStore.tryBegin(claimed.key, leaseMs);
      if (!begin.ok) {
        if (begin.reason === "committed") {
          await opts.queue.ack(opts.workerId, claimed.key);
        } else if (begin.reason === "poisoned") {
          // A prior attempt for this key terminally failed (handler timeout
          // or max-retry exhaustion). Acking the redelivered queue item
          // would let drain-gated channel adapters (notably email IMAP)
          // mark the source message handled despite no successful run.
          // Dead-letter instead so awaitDrain reports failure and the
          // adapter keeps the message in a state requiring operator
          // resolution.
          await opts.queue.deadLetter(opts.workerId, claimed.key, "poisoned-key-replay");
        } else {
          // in-flight or capacity-exhausted — another worker still owns the
          // idempotency lease, OR the store cannot accept more work right now.
          // Release the queue claim so the item can be re-attempted later;
          // never ack (acking would drop the message).
          await opts.queue.nack(opts.workerId, claimed.key);
        }
        continue;
      }
      const timeoutCtl = new AbortController();
      try {
        const handlerResult = await runWithTimeout(
          opts.handler(
            {
              key: claimed.key,
              payload: claimed.payload,
              normalized: claimed.normalized,
            },
            timeoutCtl.signal,
          ),
          opts.handlerTimeoutMs,
          timeoutCtl,
        );
        if (!handlerResult.ok) {
          // Timeout is terminal: even with the AbortSignal in hand, the
          // original handler may still be running and we cannot stop it
          // from outside (the public MessageHandler contract is
          // single-arg). Releasing the queue claim for retry would let a
          // successor execute the SAME ingress concurrently with the
          // still-running original handler and produce duplicate side
          // effects. So we dead-letter immediately and rely on the
          // operator to inspect / replay the stuck item.
          if (handlerResult.timedOut) {
            // Timeout: the public MessageHandler contract is single-
            // arg (no AbortSignal), so the worker cannot guarantee
            // the original handler stopped. We must NOT release the
            // queue claim or idempotency lease — calling nack/abort
            // would let a successor reclaim and re-execute the same
            // key while the original handler is still running,
            // duplicating side effects. Instead the worker simply
            // moves on to the next item; the queue claim and lease
            // expire naturally after `leaseMs` (handlerTimeoutMs +
            // grace), at which point a successor can claim. This is
            // the only safe contract until the public MessageHandler
            // type carries an enforceable AbortSignal.
            //
            // Trade-off: per-key throughput stalls for one leaseMs
            // window after each timeout. That is acceptable; silent
            // duplication is not.
            continue;
          }
          throw handlerResult.error;
        }
        await opts.idempotencyStore.commit(begin.lease, opts.commitTtlMs);
        await opts.queue.ack(opts.workerId, claimed.key);
      } catch (e) {
        if (claimed.attempts + 1 >= maxRetries) {
          // Dead-letter is terminal: a POISON tombstone MUST land
          // durably before deadLetter. If commitPoison throws (store
          // unavailable, lease expired) we nack rather than deadLetter
          // so a future redelivery cannot find a brand-new key and
          // re-run the handler. Operators see retries instead of
          // silent duplication on the redelivery.
          const poisonOk = await commitPoisonDurably(
            opts.idempotencyStore,
            begin.lease,
            opts.commitTtlMs,
          );
          if (poisonOk) {
            await opts.queue.deadLetter(opts.workerId, claimed.key, errorMessage(e));
          } else {
            // Same as the timeout path: release the lease so a retry
            // can claim, and nack instead of dead-lettering so no
            // terminal-marker-less drop is possible.
            await opts.idempotencyStore.abort(begin.lease).catch(() => {});
            await opts.queue.nack(opts.workerId, claimed.key);
          }
        } else {
          // Transient: abort lease so a successor retry can re-claim and
          // re-run the handler.
          await opts.idempotencyStore.abort(begin.lease).catch(() => {});
          await opts.queue.nack(opts.workerId, claimed.key);
        }
      }
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
