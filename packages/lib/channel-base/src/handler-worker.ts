/**
 * @koi/channel-base — handler worker loop.
 *
 * Polls an IngressQueue, claims items, runs the user's async handler, and
 * commits + acks on success or aborts + nacks/dead-letters on failure.
 *
 * **Lease/claim model.** The queue claim and the idempotency lease are
 * BOTH taken with `leaseMs = handlerTimeoutMs` and never renewed. The
 * handler MUST complete within that window or be cancellable via the
 * `AbortSignal`. There is deliberately NO mid-handler renewal:
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

import type { IdempotencyStore } from "./idempotency-store.js";
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
};

export function startHandlerWorker<P, N>(opts: HandlerWorkerOptions<P, N>): () => Promise<void> {
  // Lease IS the handler deadline. No renewal — see file header.
  const leaseMs = opts.handlerTimeoutMs;
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
            // Timeout is terminal AND the original handler may still be
            // running. We MUST prevent any future delivery of the same
            // ingress key (provider redelivery, operator replay) from
            // producing a concurrent duplicate execution. So we COMMIT
            // the idempotency lease — future tryBegin on this key returns
            // `committed` and the worker ack-without-running path takes
            // over — and dead-letter the queue item so operators retain
            // visibility for diagnostic replay.
            await opts.idempotencyStore.commit(begin.lease, opts.commitTtlMs).catch(() => {});
            await opts.queue.deadLetter(
              opts.workerId,
              claimed.key,
              `handler-timeout: ${handlerResult.error.message}`,
            );
            continue;
          }
          throw handlerResult.error;
        }
        await opts.idempotencyStore.commit(begin.lease, opts.commitTtlMs);
        await opts.queue.ack(opts.workerId, claimed.key);
      } catch (e) {
        await opts.idempotencyStore.abort(begin.lease).catch(() => {});
        if (claimed.attempts + 1 >= maxRetries) {
          await opts.queue.deadLetter(opts.workerId, claimed.key, errorMessage(e));
        } else {
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
