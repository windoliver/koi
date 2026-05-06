/**
 * signal-cli subprocess manager (JSON-RPC mode).
 *
 * Spawns `signal-cli -a <account> jsonRpc`, parses one-JSON-per-line
 * stdout into typed events, and writes JSON-RPC commands to stdin.
 */

export const SIGNAL_SHUTDOWN_TIMEOUT_MS = 5000;

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
): SignalProcess {
  // let requires justification: subprocess handle, undefined when not running
  let proc: SignalChildProcess | undefined;
  // let requires justification: single registered event handler
  let eventHandler: ((event: SignalEvent) => void) | undefined;
  // let requires justification: tracks subprocess liveness across async reads
  let running = false;
  // let requires justification: cancels stdout reader during stop()
  let cancelReader: (() => void) | undefined;
  // let requires justification: set true at the start of stop() so the
  // child.exited handler can distinguish an intentional shutdown (suppress
  // onUnexpectedExit) from a crash / external kill (fire onUnexpectedExit).
  let stopping = false;

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
    const event = parseEvent(json);
    if (event !== null) eventHandler?.(event);
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
        // child.exited handler above has already cleared proc/running.
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
    },

    send: async (command: SignalCommand): Promise<void> => {
      if (proc === undefined || !running) {
        throw new Error("[channel-signal] process not running");
      }
      const rpc = {
        jsonrpc: "2.0",
        method: command.method,
        params: command.params,
        id: Date.now(),
      };
      proc.stdin.write(new TextEncoder().encode(`${JSON.stringify(rpc)}\n`));
    },

    onEvent: (handler): (() => void) => {
      eventHandler = handler;
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
