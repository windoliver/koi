/* eslint-disable no-restricted-globals */
// Worker context: `self` is the DedicatedWorkerGlobalScope.
declare const self: {
  postMessage(data: unknown): void;
  addEventListener(
    type: "message",
    handler: (event: MessageEvent<unknown>) => void | Promise<void>,
  ): void;
};

/**
 * Worker entry point — runs in a dedicated Bun Worker thread.
 *
 * Receives a "run" message with code that is already a transpiled async
 * function expression of the form `(async function(tools) { ... })`.
 * The worker evaluates this expression via new Function (global scope, not
 * module scope) so user code cannot close over internal state like
 * pendingCalls. It is called with a tools Proxy and posts the final return
 * value back to the host.
 *
 * The `tools` object is a Proxy that intercepts any property access and
 * forwards the call to the host via postMessage. The host decides whether
 * the tool exists (looking it up in the registered tool map or via the
 * middleware-aware callTool function). This allows the worker to remain
 * agnostic of the registered tool set.
 *
 * This file must remain self-contained (no imports from the host package).
 */

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

const pendingCalls = new Map<string, PendingCall>();

function buildToolsProxy(): unknown {
  return new Proxy(
    {},
    {
      get(_target: object, prop: string | symbol): unknown {
        if (typeof prop !== "string") return undefined;
        return (args: unknown): Promise<unknown> => {
          // Enforce sequential-only at the worker/proxy layer. If the script
          // issues a second tools.* call while any previous call is still
          // unresolved (Promise.all, fire-and-forget), throw synchronously
          // WITHOUT posting to the host. Throwing (vs returning a rejected
          // promise) means `Promise.all([tools.a(), tools.b()])` throws
          // during array construction — the error cannot be swallowed by
          // `Promise.allSettled` — so the concurrency violation fails the
          // script by default unless the script explicitly try/catches it.
          if (pendingCalls.size > 0) {
            // Notify the host authoritatively BEFORE throwing so a script that
            // wraps the violating call in try/catch cannot swallow it. The
            // host settles the run on receipt, independent of whether the
            // throw reaches fn's top-level.
            self.postMessage({
              kind: "error",
              message:
                "Concurrent tool calls are not supported; await each tools.* call sequentially",
            });
            throw new Error(
              "Concurrent tool calls are not supported; await each tools.* call sequentially",
            );
          }
          const id = crypto.randomUUID();
          return new Promise<unknown>((resolve, reject) => {
            pendingCalls.set(id, { resolve, reject });
            // Pass args through unchanged. Host validates shape and rejects
            // non-object payloads so malformed invocations fail closed.
            self.postMessage({ kind: "call", id, name: prop, args });
          });
        };
      },
    },
  );
}

function isRunMessage(msg: unknown): msg is { kind: "run"; code: string } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).kind === "run" &&
    typeof (msg as Record<string, unknown>).code === "string"
  );
}

function isResultMessage(
  msg: unknown,
): msg is { kind: "result"; id: string; ok: boolean; value?: unknown; error?: unknown } {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).kind === "result" &&
    typeof (msg as Record<string, unknown>).id === "string" &&
    typeof (msg as Record<string, unknown>).ok === "boolean"
  );
}

self.addEventListener("message", async (event: MessageEvent<unknown>): Promise<void> => {
  const msg = event.data;

  if (isRunMessage(msg)) {
    const tools = buildToolsProxy();

    try {
      // Use new Function (not eval) so user code executes in global scope and
      // cannot close over module-level state like pendingCalls.
      // new Function still has access to Bun worker globals (fetch, self, etc.)
      // — see the security note in execute-code-tool.ts.
      const factory = new Function(`return ${msg.code}`) as () => (
        tools: unknown,
      ) => Promise<unknown>;
      const fn = factory();
      const result = await fn(tools);
      // Fail closed on missing-await: if the script returned while any tool
      // promise is still unresolved, the host should treat the run as an
      // in-flight-at-settlement failure rather than a success. Worker has
      // ground truth; host-side timing cannot reliably detect fast tools.
      if (pendingCalls.size > 0) {
        self.postMessage({
          kind: "error",
          message:
            "Script returned while a tool call was still in flight — every tools.* call must be awaited",
        });
      } else {
        self.postMessage({ kind: "done", result: result ?? null });
      }
    } catch (e: unknown) {
      self.postMessage({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }

  if (isResultMessage(msg)) {
    const pending = pendingCalls.get(msg.id);
    if (pending === undefined) return;
    pendingCalls.delete(msg.id);

    if (msg.ok) {
      pending.resolve(msg.value ?? null);
    } else {
      pending.reject(new Error(typeof msg.error === "string" ? msg.error : "Tool call failed"));
    }
  }
});
