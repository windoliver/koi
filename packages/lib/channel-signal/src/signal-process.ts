/**
 * signal-cli subprocess manager (JSON-RPC mode).
 *
 * Spawns `signal-cli -a <account> jsonRpc`, parses one-JSON-per-line
 * stdout into typed events, and writes JSON-RPC commands to stdin.
 */

export const SIGNAL_SHUTDOWN_TIMEOUT_MS = 5000;
/**
 * Per-RPC timeout. signal-cli normally responds within tens of milliseconds;
 * 30s is generous but bounds the worst case so a wedged-but-alive subprocess
 * (e.g. blocked on a JVM GC pause that never recovers, network hung mid-send)
 * surfaces as an explicit rejection instead of a permanently stuck promise.
 */
export const SIGNAL_RPC_TIMEOUT_MS = 30_000;

export interface SignalAttachment {
  readonly contentType: string;
  readonly filename?: string;
  readonly id: string;
}

export type SignalEvent =
  | {
      readonly kind: "message";
      readonly source: string;
      readonly timestamp: number;
      readonly body: string;
      readonly groupId?: string;
    }
  | { readonly kind: "receipt"; readonly source: string; readonly timestamp: number }
  | { readonly kind: "typing"; readonly source: string; readonly started: boolean };

export interface SignalCommand {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Subprocess shape returned by SpawnFn — matches Bun.spawn's relevant subset. */
export interface SignalChildProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stdin: { write(data: Uint8Array): void };
  readonly exited: Promise<unknown>;
  kill(signal?: number): void;
}

export type SpawnFn = (cmd: readonly string[]) => SignalChildProcess;

export interface SignalProcess {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly send: (command: SignalCommand) => Promise<void>;
  readonly onEvent: (handler: (event: SignalEvent) => void) => () => void;
  readonly isRunning: () => boolean;
}

export function createSignalProcess(
  account: string,
  signalCliPath: string,
  configPath: string | undefined,
  spawn: SpawnFn,
  shutdownTimeoutMs: number = SIGNAL_SHUTDOWN_TIMEOUT_MS,
  onUnexpectedExit?: () => void,
  rpcTimeoutMs: number = SIGNAL_RPC_TIMEOUT_MS,
): SignalProcess {
  // let requires justification: subprocess handle, undefined when not running
  let proc: SignalChildProcess | undefined;
  // let requires justification: single registered event handler
  let eventHandler: ((event: SignalEvent) => void) | undefined;
  // Buffer events that arrive before onEvent() has installed a handler.
  // signal-cli often replays queued inbound messages right after spawn,
  // and the adapter's lifecycle starts the process in platformConnect()
  // then attaches the handler in onPlatformEvent() a moment later.
  //
  // The buffer is intentionally unbounded: silently truncating queued
  // backlog would lose conversations after a Signal account-restart, and
  // hard-capping would surface as ingress loss with no recovery path.
  // The handler-install window is bounded by the channel lifecycle
  // (channel-base attaches in the same `connect()` call), so unbounded
  // growth is bounded in practice.
  // let requires justification: drained when onEvent installs a handler.
  const pendingEvents: SignalEvent[] = [];
  // JSON-RPC request/response correlation. Each send() creates an entry
  // keyed by request id; dispatchLine resolves it on a `result` frame and
  // rejects on an `error` frame. Stop()/unexpected-exit reject the
  // remainder so callers do not observe success against a dead subprocess.
  // let requires justification: mutable map of in-flight RPC waiters
  const pendingRpc: Map<
    number,
    {
      resolve: () => void;
      reject: (err: Error) => void;
    }
  > = new Map();
  // let requires justification: monotonically increasing JSON-RPC id
  let nextRpcId = 1;
  // let requires justification: tracks subprocess liveness across async reads
  let running = false;
  // let requires justification: cancels stdout reader during stop()
  let cancelReader: (() => void) | undefined;
  // let requires justification: set true at the start of stop() so the
  // child.exited handler can distinguish an intentional shutdown (suppress
  // onUnexpectedExit) from a crash / external kill (fire onUnexpectedExit).
  let stopping = false;

  function failAllPendingRpc(reason: string): void {
    if (pendingRpc.size === 0) return;
    const err = new Error(`[channel-signal] ${reason}`);
    for (const waiter of pendingRpc.values()) waiter.reject(err);
    pendingRpc.clear();
  }

  async function readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    // let requires justification: line buffer for partial reads
    let buffer = "";
    cancelReader = (): void => {
      void reader.cancel();
    };
    try {
      while (running) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          dispatchLine(trimmed);
        }
      }
      // EOF: flush whatever is left in the buffer. signal-cli flushes its
      // last JSON-RPC envelope on a clean exit but does not always emit a
      // trailing newline, so without this the final inbound message would
      // be silently dropped.
      const tail = (buffer + decoder.decode()).trim();
      if (tail.length > 0) dispatchLine(tail);
    } catch {
      // expected on shutdown / closed stream
    } finally {
      reader.releaseLock();
    }
  }

  function dispatchLine(line: string): void {
    // let requires justification: parsed JSON shape is unknown until validated
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    // JSON-RPC response correlation: a frame carrying our `id` and a
    // `result` or `error` matches a pending send(). Resolve/reject before
    // attempting event parsing so RPC responses are never misclassified
    // as inbound events.
    if (typeof json === "object" && json !== null && !Array.isArray(json)) {
      const obj = json as Record<string, unknown>;
      if (typeof obj.id === "number" && pendingRpc.has(obj.id)) {
        const waiter = pendingRpc.get(obj.id);
        pendingRpc.delete(obj.id);
        if (waiter !== undefined) {
          if (obj.error !== undefined) {
            const errObj =
              typeof obj.error === "object" && obj.error !== null
                ? (obj.error as Record<string, unknown>)
                : undefined;
            const message =
              errObj !== undefined && typeof errObj.message === "string"
                ? errObj.message
                : JSON.stringify(obj.error);
            waiter.reject(new Error(`[channel-signal] signal-cli error: ${message}`));
          } else {
            waiter.resolve();
          }
        }
        return;
      }
    }
    const event = parseEvent(json);
    if (event === null) return;
    if (eventHandler !== undefined) {
      eventHandler(event);
      return;
    }
    pendingEvents.push(event);
  }

  return {
    start: async (): Promise<void> => {
      if (running) return;
      const argv: string[] = [signalCliPath, "-a", account];
      if (configPath !== undefined) argv.push("--config", configPath);
      argv.push("jsonRpc");
      const child = spawn(argv);
      proc = child;
      running = true;
      // Watch for unexpected subprocess exit (signal-cli crashed, killed
      // out-of-band, etc.). Without this the adapter would keep reporting
      // running=true and silently drop sends to a dead stdin handle.
      void child.exited.then(() => {
        if (proc !== child) return; // already replaced
        if (stopping) return; // intentional shutdown — stop() owns cleanup
        running = false;
        cancelReader?.();
        cancelReader = undefined;
        proc = undefined;
        // Discard anything the dead session enqueued before an event
        // handler was installed. Without this, replayed inbound traffic
        // from a crashed signal-cli session would survive into a later
        // reconnect and dispatch as if it were fresh.
        pendingEvents.length = 0;
        // Fail any in-flight send() so callers see explicit rejection
        // instead of a hung promise after the subprocess died mid-RPC.
        failAllPendingRpc("signal-cli exited before responding to send");
        onUnexpectedExit?.();
      });
      void readStdout(child.stdout);
      // Readiness probe: race child.exited against a short startup window so
      // connect() fails fast when signal-cli dies immediately (unregistered
      // account, missing JRE, malformed config). Without this the adapter
      // would report a successful connect, accept sends, and only surface
      // the failure on the first send when stdin is already closed.
      const STARTUP_WINDOW_MS = 250;
      const earlyExit = await Promise.race<"alive" | "exited">([
        child.exited.then((): "exited" => "exited"),
        new Promise<"alive">((resolve) => setTimeout(() => resolve("alive"), STARTUP_WINDOW_MS)),
      ]);
      if (earlyExit === "exited") {
        // child.exited handler above has already cleared proc/running
        // and discarded pendingEvents from the failed session.
        throw new Error(
          `[channel-signal] signal-cli exited within ${STARTUP_WINDOW_MS}ms of spawn — check that the account "${account}" is registered and the binary at "${signalCliPath}" runs standalone`,
        );
      }
    },

    stop: async (): Promise<void> => {
      if (!running || proc === undefined) return;
      stopping = true;
      running = false;
      cancelReader?.();
      cancelReader = undefined;
      // Drop any events queued while a handler was uninstalled — they
      // belong to the session being torn down and must not survive
      // into the next reconnect.
      pendingEvents.length = 0;
      const child = proc;
      child.kill(15);
      const result = await Promise.race([
        child.exited,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), shutdownTimeoutMs),
        ),
      ]);
      if (result === "timeout") {
        // Graceful shutdown failed — force-kill and WAIT for the kernel to
        // reap the child before returning. Without this await, callers can
        // reconnect and spawn a fresh signal-cli while the old JVM is still
        // terminating, which races on account/config locks and produces
        // duplicate-process / connect-flap failures during restart loops.
        // A second short timeout bounds the worst case so a wedged child
        // does not hang stop() forever; if even SIGKILL does not exit we
        // surface that as a teardown failure rather than pretending success.
        child.kill(9);
        const SIGKILL_REAP_TIMEOUT_MS = 2000;
        const reaped = await Promise.race([
          child.exited.then(() => "exited" as const),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), SIGKILL_REAP_TIMEOUT_MS),
          ),
        ]);
        if (reaped === "timeout") {
          proc = undefined;
          stopping = false;
          throw new Error(
            `[channel-signal] signal-cli did not exit within ${SIGKILL_REAP_TIMEOUT_MS}ms after SIGKILL — old process may still hold account locks`,
          );
        }
      }
      proc = undefined;
      stopping = false;
      failAllPendingRpc("signal-cli stopped while a send was in flight");
    },

    send: async (command: SignalCommand): Promise<void> => {
      if (proc === undefined || !running) {
        throw new Error("[channel-signal] process not running");
      }
      const id = nextRpcId++;
      const rpc = {
        jsonrpc: "2.0",
        method: command.method,
        params: command.params,
        id,
      };
      // Enroll BEFORE writing — guarantees the response handler can
      // correlate even if signal-cli replies on the next event-loop tick.
      const promise = new Promise<void>((resolve, reject) => {
        pendingRpc.set(id, { resolve, reject });
      });
      // Per-request timeout: a live-but-unresponsive subprocess (JVM stall,
      // network hung mid-send) would otherwise hold this promise forever
      // and stall every queued send behind it. Reject explicitly so the
      // caller sees the degraded-dependency state and can tear the
      // adapter down instead of waiting on a wedged child.
      const timer = setTimeout(() => {
        const waiter = pendingRpc.get(id);
        if (waiter === undefined) return;
        pendingRpc.delete(id);
        waiter.reject(
          new Error(
            `[channel-signal] signal-cli did not respond to send within ${rpcTimeoutMs}ms — subprocess may be wedged`,
          ),
        );
      }, rpcTimeoutMs);
      try {
        proc.stdin.write(new TextEncoder().encode(`${JSON.stringify(rpc)}\n`));
      } catch (err: unknown) {
        clearTimeout(timer);
        pendingRpc.delete(id);
        throw err;
      }
      try {
        await promise;
      } finally {
        clearTimeout(timer);
      }
    },

    onEvent: (handler): (() => void) => {
      eventHandler = handler;
      // Drain anything signal-cli emitted before this handler was
      // installed (typical: replayed inbound messages right after spawn).
      // Splice in place so we preserve the same array reference and
      // never lose entries enqueued mid-drain.
      const drained = pendingEvents.splice(0, pendingEvents.length);
      for (const ev of drained) handler(ev);
      return (): void => {
        eventHandler = undefined;
      };
    },

    isRunning: (): boolean => running,
  };
}

/** Parses a signal-cli JSON-RPC envelope into a typed `SignalEvent`. */
export function parseEvent(json: unknown): SignalEvent | null {
  if (!isObject(json)) return null;
  const envelope = isObject(json.params) ? json.params : json;
  const inner = isObject(envelope.envelope) ? envelope.envelope : envelope;
  const dataMessage = isObject(inner.dataMessage) ? inner.dataMessage : undefined;

  if (dataMessage !== undefined && typeof dataMessage.message === "string") {
    const groupInfo = isObject(dataMessage.groupInfo) ? dataMessage.groupInfo : undefined;
    return {
      kind: "message",
      source: typeof inner.source === "string" ? inner.source : "",
      timestamp: typeof dataMessage.timestamp === "number" ? dataMessage.timestamp : Date.now(),
      body: dataMessage.message,
      ...(groupInfo !== undefined && typeof groupInfo.groupId === "string"
        ? { groupId: groupInfo.groupId }
        : {}),
    };
  }

  if (inner.receiptMessage !== undefined) {
    return {
      kind: "receipt",
      source: typeof inner.source === "string" ? inner.source : "",
      timestamp: Date.now(),
    };
  }

  if (isObject(inner.typingMessage)) {
    return {
      kind: "typing",
      source: typeof inner.source === "string" ? inner.source : "",
      started: inner.typingMessage.action === "STARTED",
    };
  }

  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
