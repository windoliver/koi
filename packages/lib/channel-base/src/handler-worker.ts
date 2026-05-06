/**
 * @koi/channel-base — handler worker loop.
 *
 * Polls an IngressQueue, claims items, runs the user's async handler under
 * an automatically-renewed IdempotencyStore lease, then commits + acks on
 * success or aborts + nacks/dead-letters on failure.
 */

import type { IdempotencyStore } from "./idempotency-store.js";
import type { IngressQueue } from "./ingress-queue.js";

export type HandlerInput<P, N> = {
  readonly key: string;
  readonly payload: P;
  readonly normalized: N;
};

/**
 * `signal` aborts when the worker loses ownership (lease/queue-claim
 * renewal failure) or hits `handlerTimeoutMs`. Handlers that perform
 * non-idempotent side effects (outbound sends, durable writes) MUST
 * honour the signal — otherwise a successor claim may execute the
 * handler concurrently, violating dedupe guarantees. Pure or naturally
 * idempotent handlers can ignore it.
 */
export type Handler<P, N> = (input: HandlerInput<P, N>, signal: AbortSignal) => Promise<void>;

export type HandlerWorkerOptions<P, N> = {
  readonly queue: IngressQueue<P, N>;
  readonly idempotencyStore: IdempotencyStore;
  readonly handler: Handler<P, N>;
  readonly commitTtlMs: number;
  readonly handlerTimeoutMs: number;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxHandlerRetries?: number;
  readonly workerId: string;
};

export function startHandlerWorker<P, N>(opts: HandlerWorkerOptions<P, N>): () => Promise<void> {
  const leaseMs = opts.leaseMs ?? 30_000;
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
          // True duplicate — handler already ran successfully elsewhere.
          await opts.queue.ack(opts.workerId, claimed.key);
        } else {
          // in-flight or capacity-exhausted — another worker still owns the
          // idempotency lease, OR the store cannot accept more work right now.
          // Release the queue claim so the item can be re-attempted; do NOT
          // ack (acking would drop the item and lose the message if the other
          // worker fails before commit).
          await opts.queue.nack(opts.workerId, claimed.key);
        }
        continue;
      }
      // Two AbortControllers track ownership: one for lease renewal failure,
      // one for queue-claim renewal failure. If either firing renewal cycle
      // fails, we abort the in-flight handler so duplicate execution under
      // the new owner cannot happen.
      const ownership = new AbortController();
      const renewerInterval = Math.max(1, Math.floor(leaseMs / 3));
      const renewer = setInterval(() => {
        // Renew BOTH the idempotency lease AND the queue claim so neither
        // expires under a long handler. Any failure aborts ownership so the
        // in-flight handler is cancelled before a successor claim could
        // execute it concurrently.
        opts.idempotencyStore.renew(begin.lease, leaseMs).catch(() => {
          if (!ownership.signal.aborted) ownership.abort(new Error("lease-renewal-failed"));
        });
        opts.queue
          .renew(opts.workerId, claimed.key, leaseMs)
          .then((r) => {
            if (!r.ok && !ownership.signal.aborted) {
              ownership.abort(new Error("queue-claim-renewal-failed"));
            }
          })
          .catch(() => {
            if (!ownership.signal.aborted) {
              ownership.abort(new Error("queue-claim-renewal-failed"));
            }
          });
      }, renewerInterval);
      try {
        const handlerResult = await runWithOwnership(
          opts.handler(
            {
              key: claimed.key,
              payload: claimed.payload,
              normalized: claimed.normalized,
            },
            ownership.signal,
          ),
          opts.handlerTimeoutMs,
          ownership.signal,
        );
        if (!handlerResult.ok) throw handlerResult.error;
        await opts.idempotencyStore.commit(begin.lease, opts.commitTtlMs);
        await opts.queue.ack(opts.workerId, claimed.key);
      } catch (e) {
        await opts.idempotencyStore.abort(begin.lease).catch(() => {});
        // If ownership was lost, do NOT count this against the retry budget —
        // the failure was infrastructure, not a bad message. Nack so the next
        // claim-cycle re-attempts.
        const ownershipLost = ownership.signal.aborted;
        if (ownershipLost) {
          await opts.queue.nack(opts.workerId, claimed.key);
        } else if (claimed.attempts + 1 >= maxRetries) {
          await opts.queue.deadLetter(opts.workerId, claimed.key, errorMessage(e));
        } else {
          await opts.queue.nack(opts.workerId, claimed.key);
        }
      } finally {
        clearInterval(renewer);
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

type OwnershipResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };

function runWithOwnership<T>(
  p: Promise<T>,
  ms: number,
  ownership: AbortSignal,
): Promise<OwnershipResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: OwnershipResult<T>): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const t = setTimeout(() => {
      settle({ ok: false, error: new Error(`handler timeout after ${ms}ms`) });
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      const reason = ownership.reason;
      settle({
        ok: false,
        error: reason instanceof Error ? reason : new Error("ownership-lost"),
      });
    };
    if (ownership.aborted) {
      onAbort();
      return;
    }
    ownership.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        ownership.removeEventListener("abort", onAbort);
        settle({ ok: true, value: v });
      },
      (e: unknown) => {
        clearTimeout(t);
        ownership.removeEventListener("abort", onAbort);
        settle({
          ok: false,
          error: e instanceof Error ? e : new Error(String(e)),
        });
      },
    );
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
