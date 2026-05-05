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

export type HandlerWorkerOptions<P, N> = {
  readonly queue: IngressQueue<P, N>;
  readonly idempotencyStore: IdempotencyStore;
  readonly handler: (item: HandlerInput<P, N>) => Promise<void>;
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
        // Already committed or in-flight elsewhere — drop from queue.
        await opts.queue.ack(opts.workerId, claimed.key);
        continue;
      }
      const renewer = setInterval(
        () => {
          opts.idempotencyStore.renew(begin.lease, leaseMs).catch(() => {});
        },
        Math.max(1, Math.floor(leaseMs / 3)),
      );
      try {
        await runWithTimeout(
          opts.handler({
            key: claimed.key,
            payload: claimed.payload,
            normalized: claimed.normalized,
          }),
          opts.handlerTimeoutMs,
        );
        await opts.idempotencyStore.commit(begin.lease, opts.commitTtlMs);
        await opts.queue.ack(opts.workerId, claimed.key);
      } catch (e) {
        await opts.idempotencyStore.abort(begin.lease).catch(() => {});
        if (claimed.attempts + 1 >= maxRetries) {
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

function runWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`handler timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
