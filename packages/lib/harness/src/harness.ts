/**
 * createCliHarness() — wires a KoiRuntime to a ChannelAdapter.
 *
 * Single-prompt mode: one turn, no channel connection required.
 * Interactive REPL: connects channel, loops per turn, enforces limits.
 *
 * L2 — only @koi/core (L0) types used here.
 */

import type { ContentBlock, EngineEvent, EngineOutput, InboundMessage } from "@koi/core";
import { renderEngineEvent, shouldRender } from "./render-event.js";
import type { CliHarness, CliHarnessConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract plain text from inbound message content blocks. */
function extractText(content: readonly ContentBlock[]): string {
  return content
    .filter((b) => b.kind === "text")
    .map((b) => (b as { readonly kind: "text"; readonly text: string }).text)
    .join(" ");
}

/**
 * Write engine events to raw stdout (no-TUI path).
 * Skips allocation for silent events via shouldRender().
 */
function writeEventsToOutput(
  output: NodeJS.WritableStream,
  event: Parameters<typeof renderEngineEvent>[0],
  verbose: boolean,
  hasPriorDeltas = false,
): void {
  if (!shouldRender(event, verbose)) return;
  const line = renderEngineEvent(event, verbose, hasPriorDeltas);
  if (line !== null) {
    output.write(line);
  }
}

/**
 * Create a push-based async iterable queue.
 * Used to feed engine events to a TUI adapter without blocking the harness.
 */
function createEventQueue(): {
  readonly push: (event: EngineEvent) => void;
  readonly end: () => void;
  readonly iterable: AsyncIterable<EngineEvent>;
} {
  const buffer: EngineEvent[] = [];
  // let: mutable resolver reassigned each time the consumer awaits a new event
  let waitResolve: (() => void) | null = null;
  let done = false;

  return {
    push(event: EngineEvent): void {
      buffer.push(event);
      waitResolve?.();
      waitResolve = null;
    },
    end(): void {
      done = true;
      waitResolve?.();
      waitResolve = null;
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        return {
          async next(): Promise<IteratorResult<EngineEvent>> {
            while (buffer.length === 0 && !done) {
              await new Promise<void>((resolve) => {
                waitResolve = resolve;
              });
            }
            if (buffer.length > 0) {
              return { value: buffer.shift() as EngineEvent, done: false };
            }
            return { value: undefined as never, done: true };
          },
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Single-prompt execution
// ---------------------------------------------------------------------------

async function runSinglePrompt(config: CliHarnessConfig, text: string): Promise<EngineOutput> {
  const verbose = config.verbose ?? false;
  const output = config.output ?? process.stdout;
  let engineOutput: EngineOutput | undefined;

  // let: mutable — only set to true when TUI.attach() succeeds
  let activeTui = false;
  // let: mutable queue — created when TUI is requested, abandoned if attach fails
  let queue: ReturnType<typeof createEventQueue> | undefined;

  if (config.tui !== null && config.tui !== undefined) {
    queue = createEventQueue();
    try {
      config.tui.attach(queue.iterable);
      activeTui = true;
    } catch {
      // TUI init failed — fall back to raw stdout (queue abandoned, will drain)
      queue = undefined;
    }
  }

  // let: mutable — true after first non-empty text_delta for this turn
  let hadDeltas = false;

  try {
    for await (const event of config.runtime.run({
      kind: "text",
      text,
      signal: config.signal,
    })) {
      if (event.kind === "text_delta" && event.delta.length > 0) hadDeltas = true;
      if (activeTui) {
        queue?.push(event);
      } else {
        writeEventsToOutput(output, event, verbose, hadDeltas && event.kind === "done");
      }
      if (event.kind === "done") {
        engineOutput = event.output;
      }
    }
  } finally {
    queue?.end();
    if (activeTui) {
      config.tui?.detach();
    }
    await config.runtime.dispose?.();
  }

  if (engineOutput === undefined) {
    throw new Error(
      "koi: engine stream ended without a 'done' event — the run was truncated or the adapter has a bug",
    );
  }

  return engineOutput;
}

// ---------------------------------------------------------------------------
// Interactive REPL
// ---------------------------------------------------------------------------

async function runInteractive(config: CliHarnessConfig): Promise<void> {
  const verbose = config.verbose ?? false;
  const maxTurns = config.maxTurns ?? Number.MAX_SAFE_INTEGER;
  const output = config.output ?? process.stdout;

  // Message queue + resolver for callback-to-async-iteration bridge.
  // Register onMessage BEFORE connect so messages queued during connect are not lost.
  const pending: InboundMessage[] = [];
  // let is justified: resolve is reassigned each time we wait for a message
  let wakeUp: (() => void) | null = null;

  const unsubscribe = config.channel.onMessage(async (msg) => {
    pending.push(msg);
    wakeUp?.();
    wakeUp = null;
  });

  await config.channel.connect();

  let turnCount = 0;
  const signal = config.signal;

  try {
    while (signal === undefined || !signal.aborted) {
      // Wait for a message to arrive
      if (pending.length === 0) {
        await new Promise<void>((resolve) => {
          wakeUp = resolve;
          // Wake immediately if abort fires while waiting.
          // Capture the handler so we can remove it when a message arrives first,
          // preventing listener accumulation across turns (MaxListenersExceededWarning).
          const onAbort = (): void => resolve();
          signal?.addEventListener("abort", onAbort, { once: true });
          // Wrap wakeUp so the abort listener is cleaned up on message arrival.
          wakeUp = (): void => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
        });
      }

      if (signal?.aborted) break;

      const msg = pending.shift();
      if (msg === undefined) continue;

      // Turn limit check
      if (turnCount >= maxTurns) {
        await config.channel.send({
          content: [
            {
              kind: "text",
              text: `Session limit reached (${maxTurns} turns). Start a new session.`,
            },
          ],
        });
        break;
      }

      turnCount++;
      const userText = extractText(msg.content);

      // let: mutable — only set to true when TUI.attach() succeeds
      let activeTuiTurn = false;
      // let: mutable queue — created when TUI requested, abandoned if attach fails
      let queue: ReturnType<typeof createEventQueue> | undefined;

      if (config.tui !== null && config.tui !== undefined) {
        queue = createEventQueue();
        try {
          config.tui.attach(queue.iterable);
          activeTuiTurn = true;
        } catch {
          // TUI init failed — fall back to raw stdout
          queue = undefined;
        }
      }

      // let: mutable — true after first non-empty text_delta for this turn
      let hadDeltas = false;
      // let: mutable — true when a done event is received; guards against truncated streams
      let sawDone = false;

      try {
        for await (const event of config.runtime.run({
          kind: "text",
          text: userText,
          signal,
        })) {
          if (event.kind === "text_delta" && event.delta.length > 0) hadDeltas = true;
          if (event.kind === "done") sawDone = true;
          if (activeTuiTurn) {
            queue?.push(event);
          } else {
            // Direct stdout streaming — CLI output is live during the turn.
            writeEventsToOutput(output, event, verbose, hadDeltas && event.kind === "done");
          }
        }
        if (!sawDone) {
          // Fail closed — treat a truncated engine stream as a hard error so partial
          // output is not silently accepted as a valid turn.
          throw new Error(
            "koi: engine stream ended without a 'done' event — the run was truncated or the adapter has a bug",
          );
        }
      } finally {
        queue?.end();
        if (activeTuiTurn) {
          config.tui?.detach();
        }
      }
      // Note: channel.send() is intentionally NOT called here.
      // For CLI channels, live text_delta streaming IS the reply output.
      // Non-CLI channels (e.g., WebSocket) use a different harness variant.
    }
  } finally {
    unsubscribe();
    await config.channel.disconnect();
    await config.runtime.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CLI harness that wires a KoiRuntime to a ChannelAdapter.
 *
 * Config is captured at creation time; the returned CliHarness methods are
 * safe to call once (calling run* more than once per harness is undefined behavior).
 */
export function createCliHarness(config: CliHarnessConfig): CliHarness {
  return {
    runSinglePrompt: (text: string) => runSinglePrompt(config, text),
    runInteractive: () => runInteractive(config),
  };
}
