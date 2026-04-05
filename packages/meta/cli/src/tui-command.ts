/**
 * `koi tui` command handler.
 *
 * Wires together the TUI application shell:
 *   store + permissionBridge + batcher → createTuiApp → handle.start()
 *
 * Engine wiring (issue #1459): the drain loop infrastructure is in place.
 * Replace the placeholder onSubmit with a real EngineAdapter stream once
 * createRuntime() is available. The engine-worker.ts already has the worker
 * protocol ready for the background-thread path.
 *
 * Direct stream (Decision 2A from review): this command runs the store dispatch
 * loop in the main thread. Move to the Worker path (engine-worker.ts) when the
 * adapter is wired and isolation is needed.
 */

import type { EngineEvent } from "@koi/core/engine";
import type { EventBatcher, TuiStore } from "@koi/tui";
import {
  createEventBatcher,
  createInitialState,
  createPermissionBridge,
  createStore,
  createTuiApp,
} from "@koi/tui";
import type { TuiFlags } from "./args.js";

// ---------------------------------------------------------------------------
// Drain loop (exported for unit testing — Decision 4A from test review)
// ---------------------------------------------------------------------------

/**
 * Drain an async engine event stream into the store via the batcher.
 *
 * Sets connection status to "connected" before streaming, "disconnected" after.
 * On stream failure: dispatches add_error + disconnected (Decision 3A from code
 * quality review — error handling wraps the drain loop with try/catch/finally).
 *
 * Exported for testing. Not part of the public @koi/tui API.
 */
export async function drainEngineStream(
  stream: AsyncIterable<EngineEvent>,
  store: TuiStore,
  batcher: EventBatcher<EngineEvent>,
): Promise<void> {
  store.dispatch({ kind: "set_connection_status", status: "connected" });
  try {
    for await (const event of stream) {
      batcher.enqueue(event);
    }
    batcher.flushSync();
  } catch (e: unknown) {
    batcher.flushSync();
    store.dispatch({
      kind: "add_error",
      code: "ENGINE_ERROR",
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    store.dispatch({ kind: "set_connection_status", status: "disconnected" });
  }
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export async function runTuiCommand(flags: TuiFlags): Promise<void> {
  const store = createStore(createInitialState());
  const permissionBridge = createPermissionBridge({ store });

  // Event batcher: coalesces rapid engine events into 16ms flush windows
  // matching the OpenTUI render cadence (Decision 2A — direct stream path).
  const batcher = createEventBatcher<EngineEvent>((batch) => {
    for (const event of batch) {
      store.dispatch({ kind: "engine_event", event });
    }
  });

  // `let` justified: captured after createTuiApp resolves, used in onCommand
  // and signal handlers. The variable is set once before any callbacks fire.
  let appHandle: { readonly stop: () => Promise<void> } | null = null;

  const onInterrupt = (): void => {
    permissionBridge.dispose();
    // Agent interrupt — engine wiring (#1459) will cancel the stream here
  };

  const result = createTuiApp({
    store,
    permissionBridge,
    onCommand: (commandId: string): void => {
      switch (commandId) {
        case "agent:interrupt":
          onInterrupt();
          break;
        case "agent:clear":
          store.dispatch({ kind: "clear_messages" });
          break;
        case "system:quit":
          void appHandle?.stop().then(() => process.exit(0));
          break;
        // Other commands (agent:compact, session:*, system:*) are stubs
        // until engine wiring lands in #1459.
        default:
          break;
      }
    },
    onSessionSelect: (sessionId: string): void => {
      // Navigate back to conversation and signal the host to load the session.
      store.dispatch({ kind: "set_view", view: "conversation" });
      // TODO (#1459): wire session loading
      void sessionId;
    },
    onSubmit: async (text: string): Promise<void> => {
      store.dispatch({
        kind: "add_user_message",
        id: `user-${Date.now()}`,
        blocks: [{ kind: "text", text }],
      });

      // TODO (#1459): Replace with real EngineAdapter stream.
      // Infrastructure for the drain loop is here — swap this placeholder with:
      //   const stream = runtime.adapter.stream(input, { signal });
      //   await drainEngineStream(stream, store, batcher);
      store.dispatch({
        kind: "add_error",
        code: "ENGINE_NOT_CONFIGURED",
        message:
          "No engine configured yet. " +
          (flags.agent !== undefined
            ? `Agent '${flags.agent}' not wired — engine adapter pending (#1459).`
            : "Pass --agent <manifest> once engine wiring lands (#1459)."),
      });
    },
    onInterrupt,
  });

  if (!result.ok) {
    process.stderr.write("error: koi tui requires a TTY (stdout is not a terminal)\n");
    process.exit(1);
  }

  appHandle = result.value;

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = (): void => {
    void result.value.stop().then(() => {
      batcher.dispose();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await result.value.start();
  // Block until stop() completes (SIGINT/SIGTERM/quit command all call stop()
  // and then process.exit — done() resolves right before that exit).
  await result.value.done();
}
