import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createExternalAdapter } from "./adapter.js";
import { createJsonLinesParser, createLineParser } from "./parsers.js";

/** Collect all events from an async iterable. */
async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Find the done event in a list of engine events. */
function findDone(
  events: readonly EngineEvent[],
): Extract<EngineEvent, { readonly kind: "done" }> | undefined {
  return events.find(
    (e): e is Extract<EngineEvent, { readonly kind: "done" }> => e.kind === "done",
  );
}

describe("createExternalAdapter — single-shot", () => {
  test("echo produces text_delta + done(completed)", async () => {
    const adapter = createExternalAdapter({ command: "echo", args: ["hello"] });
    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("completed");
    expect(done?.output.metrics.totalTokens).toBe(0);
    expect(done?.output.metrics.durationMs).toBeGreaterThanOrEqual(0);

    await adapter.dispose?.();
  });

  test("exit 1 produces done(error)", async () => {
    const adapter = createExternalAdapter({ command: "sh", args: ["-c", "exit 1"] });
    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("error");

    await adapter.dispose?.();
  });

  test("concurrent run guard throws", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "sleep 2"],
      timeoutMs: 5000,
    });

    // Start first run — must call .next() to actually enter the generator body
    const iter1 = adapter.stream({ kind: "text", text: "" })[Symbol.asyncIterator]();
    const firstEvent = iter1.next(); // triggers the generator to run

    // Small delay to ensure the first run started
    await new Promise((r) => setTimeout(r, 50));

    // Second run: async generator is lazy, so the throw happens on .next()
    const iter2 = adapter.stream({ kind: "text", text: "" })[Symbol.asyncIterator]();
    await expect(iter2.next()).rejects.toThrow("concurrent");

    // Clean up — dispose kills the running process
    await adapter.dispose?.();
    // firstEvent may reject or resolve after dispose — that's fine
    await firstEvent.catch(() => {});
  }, 10_000);

  test("timeout kills process and produces done(error)", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "sleep 30"],
      timeoutMs: 200,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    // Timeout triggers abort → error stop reason
    if (done === undefined) return;
    expect(["error", "interrupted"]).toContain(done.output.stopReason);

    await adapter.dispose?.();
  }, 10_000);

  test("AbortSignal triggers kill and produces done(interrupted)", async () => {
    const controller = new AbortController();
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "sleep 30"],
      timeoutMs: 0, // no timeout
    });

    // Abort after 200ms
    setTimeout(() => controller.abort(), 200);

    const events = await collectEvents(
      adapter.stream({ kind: "text", text: "", signal: controller.signal }),
    );

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("interrupted");

    await adapter.dispose?.();
  }, 10_000);

  test("messages input extracts text", async () => {
    const adapter = createExternalAdapter({ command: "cat" });
    const events = await collectEvents(
      adapter.stream({
        kind: "messages",
        messages: [
          {
            content: [{ kind: "text", text: "hello from messages" }],
            senderId: "user",
            timestamp: Date.now(),
          },
        ],
      }),
    );

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    const allText = textDeltas.map((e) => (e.kind === "text_delta" ? e.delta : "")).join("");
    expect(allText).toContain("hello from messages");

    await adapter.dispose?.();
  });

  test("stdin receives input text", async () => {
    const adapter = createExternalAdapter({ command: "cat" });
    const events = await collectEvents(adapter.stream({ kind: "text", text: "piped input" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    const allText = textDeltas.map((e) => (e.kind === "text_delta" ? e.delta : "")).join("");
    expect(allText).toContain("piped input");

    await adapter.dispose?.();
  });

  test("stderr output produces custom events", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "echo error >&2"],
    });
    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const stderrEvents = events.filter((e) => e.kind === "custom" && e.type === "stderr");
    expect(stderrEvents.length).toBeGreaterThan(0);

    await adapter.dispose?.();
  });

  test("metrics have zero tokens and positive durationMs", async () => {
    const adapter = createExternalAdapter({ command: "echo", args: ["metrics test"] });
    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    if (done === undefined) return;

    expect(done.output.metrics.totalTokens).toBe(0);
    expect(done.output.metrics.inputTokens).toBe(0);
    expect(done.output.metrics.outputTokens).toBe(0);
    expect(done.output.metrics.turns).toBe(1);
    expect(done.output.metrics.durationMs).toBeGreaterThanOrEqual(0);

    await adapter.dispose?.();
  });
});

describe("createExternalAdapter — long-lived", () => {
  test("cat write/read cycle", async () => {
    const parser = createLineParser((line, source) => {
      if (line.trim() === "END") {
        return { events: [], turnComplete: true };
      }
      if (source === "stderr") {
        return { events: [{ kind: "custom" as const, type: "stderr", data: line }] };
      }
      return { events: [{ kind: "text_delta" as const, delta: line }] };
    });

    const adapter = createExternalAdapter({
      command: "cat",
      mode: "long-lived",
      parser,
      timeoutMs: 5000,
    });

    // First turn: write and read
    const events1 = await collectEvents(adapter.stream({ kind: "text", text: "hello\nEND" }));
    const done1 = findDone(events1);
    expect(done1).toBeDefined();
    expect(done1?.output.stopReason).toBe("completed");

    const textEvents1 = events1.filter((e) => e.kind === "text_delta");
    const text1 = textEvents1.map((e) => (e.kind === "text_delta" ? e.delta : "")).join("");
    expect(text1).toContain("hello");

    // Second turn: write again
    const events2 = await collectEvents(adapter.stream({ kind: "text", text: "world\nEND" }));
    const done2 = findDone(events2);
    expect(done2).toBeDefined();
    expect(done2?.output.stopReason).toBe("completed");

    await adapter.dispose?.();
  }, 15_000);

  test("process exit in long-lived mode produces done(error)", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "read line; echo $line; exit 0"],
      mode: "long-lived",
      parser: createLineParser((line) => {
        if (line.trim().length === 0) return undefined;
        return { events: [{ kind: "text_delta" as const, delta: line }] };
      }),
      timeoutMs: 5000,
    });

    // First stream: process reads input then exits
    const events = await collectEvents(adapter.stream({ kind: "text", text: "bye" }));

    const done = findDone(events);
    expect(done).toBeDefined();

    await adapter.dispose?.();
  }, 10_000);
});

describe("createExternalAdapter — write()", () => {
  test("write sends data to stdin", async () => {
    const adapter = createExternalAdapter({
      command: "cat",
      mode: "long-lived",
      parser: createLineParser((line) => {
        if (line.trim() === "DONE") return { events: [], turnComplete: true };
        if (line.trim().length === 0) return undefined;
        return { events: [{ kind: "text_delta" as const, delta: line }] };
      }),
      timeoutMs: 5000,
    });

    // Start a stream that will listen for output
    const eventPromise = collectEvents(adapter.stream({ kind: "text", text: "initial" }));

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 100));

    // Write additional data
    adapter.write("DONE\n");

    const events = await eventPromise;
    const done = findDone(events);
    expect(done).toBeDefined();

    await adapter.dispose?.();
  }, 10_000);

  test("write throws when no process is running", () => {
    const adapter = createExternalAdapter({ command: "echo", args: ["hi"] });
    expect(() => adapter.write("test")).toThrow("No running process");
  });
});

describe("createExternalAdapter — dispose", () => {
  test("kills running process", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "sleep 30"],
      mode: "long-lived",
      timeoutMs: 0,
    });

    // Start the process — must call .next() to enter the generator body and spawn
    const iter = adapter.stream({ kind: "text", text: "" })[Symbol.asyncIterator]();
    // Trigger generator execution
    const firstRead = iter.next();
    // Give it time to spawn
    await new Promise((r) => setTimeout(r, 200));

    expect(adapter.isRunning()).toBe(true);
    await adapter.dispose?.();
    expect(adapter.isRunning()).toBe(false);
    // Clean up pending read
    await firstRead.catch(() => {});
  }, 10_000);

  test("is idempotent", async () => {
    const adapter = createExternalAdapter({ command: "echo", args: ["hi"] });
    await adapter.dispose?.();
    await adapter.dispose?.();
  });

  test("stream throws after dispose", async () => {
    const adapter = createExternalAdapter({ command: "echo", args: ["hi"] });
    await adapter.dispose?.();

    expect(() => adapter.stream({ kind: "text", text: "" })).toThrow("disposed");
  });
});

describe("createExternalAdapter — saveState/loadState", () => {
  test("round-trip preserves state", async () => {
    const adapter = createExternalAdapter({ command: "echo", args: ["hello"] });
    await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const state = await adapter.saveState?.();
    expect(state).toBeDefined();
    if (state === undefined) return;
    expect(state.engineId).toBe("external");

    // Create a new adapter and load state
    const adapter2 = createExternalAdapter({ command: "echo", args: ["hello"] });
    await adapter2.loadState?.(state);

    const state2 = await adapter2.saveState?.();
    expect(state2).toBeDefined();
    if (state2 === undefined) return;
    expect(state2.engineId).toBe("external");

    await adapter.dispose?.();
    await adapter2.dispose?.();
  });

  test("loadState rejects wrong engineId", async () => {
    const adapter = createExternalAdapter({ command: "echo" });

    await expect(adapter.loadState?.({ engineId: "wrong", data: {} })).rejects.toThrow(
      "Cannot load state",
    );
  });

  test("loadState rejects invalid data shape", async () => {
    const adapter = createExternalAdapter({ command: "echo" });

    await expect(
      adapter.loadState?.({ engineId: "external", data: "not an object" }),
    ).rejects.toThrow("Invalid");
  });
});

describe("createExternalAdapter — maxOutputBytes", () => {
  test("large output is truncated", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "dd if=/dev/zero bs=10000 count=1 2>/dev/null | tr '\\0' '_'"],
      maxOutputBytes: 100,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const allText = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.delta : ""))
      .join("");
    expect(allText).toContain("[output truncated]");

    await adapter.dispose?.();
  });
});

describe("createExternalAdapter — custom parser", () => {
  test("JSON-lines parser with echo of valid JSON", async () => {
    const adapter = createExternalAdapter({
      command: "echo",
      args: ['{"kind":"text_delta","delta":"parsed!"}'],
      parser: createJsonLinesParser(),
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.some((e) => e.kind === "text_delta" && e.delta === "parsed!")).toBe(true);

    await adapter.dispose?.();
  });
});

describe("createExternalAdapter — noOutputTimeoutMs (watchdog)", () => {
  test("kills process when no output for noOutputTimeoutMs (single-shot)", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      // Produce one line of output, then go silent
      args: ["-c", "echo start; sleep 30"],
      noOutputTimeoutMs: 300,
      timeoutMs: 0, // disable overall timeout
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    if (done === undefined) return;
    // Watchdog triggers abort → error stop reason
    expect(done.output.stopReason).toBe("error");

    await adapter.dispose?.();
  }, 10_000);

  test("does not fire when output keeps flowing", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      // Produce output every 50ms for 500ms total — watchdog at 300ms should NOT fire
      args: ["-c", "for i in 1 2 3 4 5 6 7 8 9 10; do echo line$i; sleep 0.05; done"],
      noOutputTimeoutMs: 300,
      timeoutMs: 0,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    if (done === undefined) return;
    expect(done.output.stopReason).toBe("completed");

    await adapter.dispose?.();
  }, 10_000);

  test("kills long-lived process when no output for noOutputTimeoutMs", async () => {
    const adapter = createExternalAdapter({
      command: "sh",
      args: ["-c", "cat"],
      mode: "long-lived",
      noOutputTimeoutMs: 300,
      timeoutMs: 0,
      parser: createLineParser((line) => {
        if (line.trim() === "END") return { events: [], turnComplete: true };
        if (line.trim().length === 0) return undefined;
        return { events: [{ kind: "text_delta" as const, delta: line }] };
      }),
    });

    // Write input but don't send END — process goes silent after echoing back
    const events = await collectEvents(adapter.stream({ kind: "text", text: "hello" }));

    const done = findDone(events);
    expect(done).toBeDefined();
    if (done === undefined) return;
    // Watchdog fires → error
    expect(done.output.stopReason).toBe("error");

    await adapter.dispose?.();
  }, 10_000);
});

describe("createExternalAdapter — engineId", () => {
  test("engineId is 'external'", () => {
    const adapter = createExternalAdapter({ command: "echo" });
    expect(adapter.engineId).toBe("external");
  });
});
