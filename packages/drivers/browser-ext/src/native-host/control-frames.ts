import { z } from "zod";

/**
 * Control frames flow ONLY on the NM channel (host ↔ extension stdin/stdout).
 * They are NEVER forwarded to the driver socket. Strictly disjoint from NmFrame.
 */

export interface ExtensionHello {
  readonly kind: "extension_hello";
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly installId: string | null;
  readonly browserSessionId: string;
  readonly supportedProtocols: readonly number[];
  readonly identity?:
    | {
        readonly instanceId: string;
        readonly browserSessionId: string;
        readonly browserHint: string;
        readonly name: string;
      }
    | undefined;
  readonly epoch?: number | undefined;
  readonly seq?: number | undefined;
}

export interface HostHello {
  readonly kind: "host_hello";
  readonly hostVersion: string;
  readonly installId: string;
  readonly selectedProtocol: number;
}

export interface Ping {
  readonly kind: "ping";
  readonly seq: number;
}

export interface Pong {
  readonly kind: "pong";
  readonly seq: number;
}

export type NmControlFrame = ExtensionHello | HostHello | Ping | Pong;

export const NmControlFrameSchema: z.ZodType<NmControlFrame> = z.union([
  z.object({
    kind: z.literal("extension_hello"),
    extensionId: z.string(),
    extensionVersion: z.string(),
    installId: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    browserSessionId: z.string(),
    supportedProtocols: z.array(z.number().int().positive()),
    identity: z
      .object({
        instanceId: z.string().uuid(),
        browserSessionId: z.string().uuid(),
        browserHint: z.string(),
        name: z.string(),
      })
      .optional(),
    epoch: z.number().int().positive().optional(),
    seq: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("host_hello"),
    hostVersion: z.string(),
    installId: z.string().regex(/^[0-9a-f]{64}$/),
    selectedProtocol: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("ping"),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("pong"),
    seq: z.number().int().nonnegative(),
  }),
]);

export interface ProtocolNegotiationSuccess {
  readonly ok: true;
  readonly selectedProtocol: number;
}

export interface ProtocolNegotiationFailure {
  readonly ok: false;
}

export function negotiateProtocol(
  extensionSupported: readonly number[],
  hostSupported: readonly number[],
): ProtocolNegotiationSuccess | ProtocolNegotiationFailure {
  const shared = extensionSupported.filter((p) => hostSupported.includes(p)).sort((a, b) => b - a);
  const [selected] = shared;
  if (selected === undefined) return { ok: false };
  return { ok: true, selectedProtocol: selected };
}

export interface WatchdogConfig {
  readonly intervalMs: number;
  readonly maxMisses: number;
  readonly send: (frame: { readonly kind: "ping"; readonly seq: number }) => void;
  readonly onExpire: () => void;
  readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void; close?: () => void };
  readonly clearTimer?: (handle: unknown) => void;
}

export interface Watchdog {
  readonly start: () => void;
  readonly stop: () => void;
  readonly onPong: (seq: number) => void;
}

export function createWatchdog(config: WatchdogConfig): Watchdog {
  const setT = config.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearT = config.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let timer: unknown = null;
  let nextSeq = 0;
  const pending = new Set<number>();
  let misses = 0;
  let stopped = false;

  function tick(): void {
    if (stopped) return;
    if (pending.size > 0) {
      misses += 1;
      if (misses >= config.maxMisses) {
        stopped = true;
        if (timer !== null) clearT(timer);
        config.onExpire();
        return;
      }
    }
    const seq = nextSeq++;
    pending.add(seq);
    config.send({ kind: "ping", seq });
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setT(tick, config.intervalMs);
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
    },
    onPong(seq: number): void {
      if (pending.delete(seq)) {
        misses = 0;
      }
    },
  };
}
