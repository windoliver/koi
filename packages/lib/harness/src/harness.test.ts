import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChannelAdapter, EngineEvent, EngineInput, TuiAdapter } from "@koi/core";
import { createCliHarness } from "./harness.js";
import type { HarnessRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeRuntime(events: readonly EngineEvent[]): HarnessRuntime {
  return {
    run: (_input: EngineInput) =>
      (async function* () {
        for (const event of events) {
          yield event;
        }
      })(),
    dispose: mock(() => Promise.resolve()),
  };
}

function makeChannel(): ChannelAdapter & {
  readonly sentMessages: readonly { readonly content: readonly unknown[] }[];
  readonly triggerMessage: (text: string) => void;
} {
  const sent: { readonly content: readonly unknown[] }[] = [];
  const handlers: Array<(msg: { content: readonly { kind: string; text: string }[] }) => void> = [];
  return {
    name: "test-channel",
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: false,
      supportsA2ui: false,
    },
    connect: mock(() => Promise.resolve()),
    disconnect: mock(() => Promise.resolve()),
    send: mock((msg) => {
      sent.push(msg);
      return Promise.resolve();
    }),
    onMessage: mock((handler) => {
      handlers.push(handler as never);
      return () => {};
    }),
    sentMessages: sent,
    triggerMessage: (text: string) => {
      for (const h of handlers) {
        h({ content: [{ kind: "text", text }] });
      }
    },
  };
}

const DONE_EVENT: EngineEvent = {
  kind: "done",
  output: {
    content: [{ kind: "text", text: "reply" }],
    stopReason: "completed",
    metrics: { totalTokens: 10, inputTokens: 5, outputTokens: 5, turns: 1, durationMs: 50 },
  },
};

// ---------------------------------------------------------------------------
// Single-prompt mode
// ---------------------------------------------------------------------------

describe("createCliHarness — runSinglePrompt", () => {
  test("returns EngineOutput from done event", async () => {
    const runtime = makeRuntime([{ kind: "text_delta", delta: "hello" }, DONE_EVENT]);
    const channel = makeChannel();
    const output: string[] = [];
    const harness = createCliHarness({
      runtime,
      channel,
      tui: null,
      output: {
        write: (s: string) => {
          output.push(s);
          return true;
        },
      } as never,
    });

    const result = await harness.runSinglePrompt("list files");
    expect(result.stopReason).toBe("completed");
  });

  test("renders text_delta to output stream (no-TUI path)", async () => {
    const written: string[] = [];
    const runtime = makeRuntime([{ kind: "text_delta", delta: "hello " }, DONE_EVENT]);
    const channel = makeChannel();
    const harness = createCliHarness({
      runtime,
      channel,
      tui: null,
      output: {
        write: (s: string) => {
          written.push(s);
          return true;
        },
      } as never,
    });

    await harness.runSinglePrompt("test");
    expect(written.some((s) => s === "hello ")).toBe(true);
  });

  test("does NOT write to output when TUI is present (TUI path)", async () => {
    const written: string[] = [];
    const tuiAdapter: TuiAdapter = {
      attach: mock(() => {}),
      detach: mock(() => {}),
    };
    const runtime = makeRuntime([{ kind: "text_delta", delta: "hello" }, DONE_EVENT]);
    const channel = makeChannel();
    const harness = createCliHarness({
      runtime,
      channel,
      tui: tuiAdapter,
      output: {
        write: (s: string) => {
          written.push(s);
          return true;
        },
      } as never,
    });

    await harness.runSinglePrompt("test");
    // Only the "done" newline may appear; text_delta should not
    const nonNewline = written.filter((s) => s !== "\n");
    expect(nonNewline.length).toBe(0);
  });

  test("calls runtime.dispose() after completion", async () => {
    const runtime = makeRuntime([DONE_EVENT]);
    const channel = makeChannel();
    const harness = createCliHarness({ runtime, channel, tui: null });

    await harness.runSinglePrompt("test");
    expect((runtime.dispose as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test("calls runtime.dispose() even when engine throws", async () => {
    const throwingRuntime: HarnessRuntime = {
      run: (): AsyncIterable<EngineEvent> => {
        throw new Error("engine exploded");
      },
      dispose: mock(() => Promise.resolve()),
    };
    const channel = makeChannel();
    const harness = createCliHarness({ runtime: throwingRuntime, channel, tui: null });

    await expect(harness.runSinglePrompt("test")).rejects.toThrow("engine exploded");
    expect((throwingRuntime.dispose as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Interactive REPL — basic lifecycle
// ---------------------------------------------------------------------------

describe("createCliHarness — runInteractive", () => {
  let channel: ReturnType<typeof makeChannel>;

  beforeEach(() => {
    channel = makeChannel();
  });

  test("connects and disconnects the channel", async () => {
    const controller = new AbortController();
    const runtime = makeRuntime([DONE_EVENT]);
    const harness = createCliHarness({
      runtime,
      channel,
      tui: null,
      signal: controller.signal,
    });

    const done = harness.runInteractive();
    // Abort immediately — channel should still connect + disconnect
    controller.abort();
    await done;

    expect((channel.connect as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((channel.disconnect as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test("streams agent reply to stdout during a turn (not via channel.send)", async () => {
    const controller = new AbortController();
    const events: EngineEvent[] = [{ kind: "text_delta", delta: "Agent says hello" }, DONE_EVENT];
    const runtime = makeRuntime(events);
    const written: string[] = [];
    const harness = createCliHarness({
      runtime,
      channel,
      tui: null,
      signal: controller.signal,
      output: {
        write: (s: string) => {
          written.push(s);
          return true;
        },
      } as never,
    });

    const done = harness.runInteractive();
    channel.triggerMessage("hi");
    // Give the turn time to process
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await done;

    // Reply is streamed directly to stdout — channel.send() is NOT called for agent replies.
    expect(written.some((s) => s === "Agent says hello")).toBe(true);
    // channel.send() should only be used for system messages (e.g., turn limit), not agent text.
    const agentReply = channel.sentMessages.find((m) => {
      const text = (m.content[0] as { text?: string } | undefined)?.text ?? "";
      return text.includes("Agent says hello");
    });
    expect(agentReply).toBeUndefined();
  });

  test("enforces maxTurns — sends limit message and stops", async () => {
    const controller = new AbortController();
    let callCount = 0;
    const limitedRuntime: HarnessRuntime = {
      run: (_input) =>
        (async function* () {
          callCount++;
          yield { kind: "text_delta", delta: `turn ${callCount}` } as EngineEvent;
          yield DONE_EVENT;
        })(),
    };
    const harness = createCliHarness({
      runtime: limitedRuntime,
      channel,
      tui: null,
      signal: controller.signal,
      maxTurns: 2,
    });

    const done = harness.runInteractive();
    channel.triggerMessage("message 1");
    await new Promise((r) => setTimeout(r, 30));
    channel.triggerMessage("message 2");
    await new Promise((r) => setTimeout(r, 30));
    // Third message should trigger the limit message
    channel.triggerMessage("message 3");
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await done;

    // Expect the limit message to have been sent
    const allText = channel.sentMessages
      .flatMap((m) => m.content as { text?: string }[])
      .map((b) => b.text ?? "")
      .join(" ");
    expect(allText).toContain("limit reached");
  });
});

// ---------------------------------------------------------------------------
// Abort signal — unit test: signal is forwarded into engine input
// ---------------------------------------------------------------------------

describe("createCliHarness — abort signal propagation", () => {
  test("AbortSignal is passed to runtime.run()", async () => {
    const receivedInputs: EngineInput[] = [];
    const tracingRuntime: HarnessRuntime = {
      run: (input) => {
        receivedInputs.push(input);
        return (async function* () {
          yield DONE_EVENT;
        })();
      },
    };
    const controller = new AbortController();
    const harness = createCliHarness({
      runtime: tracingRuntime,
      channel: makeChannel(),
      tui: null,
      signal: controller.signal,
    });

    await harness.runSinglePrompt("test");

    expect(receivedInputs.length).toBe(1);
    expect(receivedInputs[0]?.signal).toBe(controller.signal);
  });

  test("abort before REPL starts — loop exits immediately", async () => {
    const controller = new AbortController();
    controller.abort(); // pre-aborted
    const runtime = makeRuntime([DONE_EVENT]);
    const channel = makeChannel();
    const harness = createCliHarness({
      runtime,
      channel,
      tui: null,
      signal: controller.signal,
    });

    // Should not hang
    await harness.runInteractive();
    expect((channel.connect as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((channel.disconnect as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TUI path vs no-TUI path (Issue 10)
// ---------------------------------------------------------------------------

describe("createCliHarness — TUI adapter branching", () => {
  test("tui: null — events go to output stream", async () => {
    const written: string[] = [];
    const runtime = makeRuntime([{ kind: "text_delta", delta: "raw" }, DONE_EVENT]);
    const harness = createCliHarness({
      runtime,
      channel: makeChannel(),
      tui: null,
      output: {
        write: (s: string) => {
          written.push(s);
          return true;
        },
      } as never,
    });

    await harness.runSinglePrompt("x");
    expect(written.some((s) => s === "raw")).toBe(true);
  });

  test("tui provided — text_delta NOT written to output stream", async () => {
    const written: string[] = [];
    const tui: TuiAdapter = { attach: mock(() => {}), detach: mock(() => {}) };
    const runtime = makeRuntime([{ kind: "text_delta", delta: "tui-output" }, DONE_EVENT]);
    const harness = createCliHarness({
      runtime,
      channel: makeChannel(),
      tui,
      output: {
        write: (s: string) => {
          written.push(s);
          return true;
        },
      } as never,
    });

    await harness.runSinglePrompt("x");
    expect(written.some((s) => s === "tui-output")).toBe(false);
  });

  test("tui that throws on attach — harness falls back to stdout and does not call detach", async () => {
    const throwingTui: TuiAdapter = {
      attach: mock(() => {
        throw new Error("TUI init failed");
      }),
      detach: mock(() => {}),
    };
    const written: string[] = [];
    const runtime = makeRuntime([{ kind: "text_delta", delta: "fallback" }, DONE_EVENT]);
    const harness = createCliHarness({
      runtime,
      channel: makeChannel(),
      tui: throwingTui,
      output: {
        write: (s: string) => {
          written.push(s);
          return true;
        },
      } as never,
    });

    // Should not throw despite TUI failing — falls back to stdout
    await expect(harness.runSinglePrompt("test")).resolves.toBeDefined();
    // Stdout received the output (fallback worked)
    expect(written.some((s) => s === "fallback")).toBe(true);
    // detach is NOT called when attach never succeeded
    expect((throwingTui.detach as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("tui.attach() and tui.detach() are called by the harness", async () => {
    const tui: TuiAdapter = { attach: mock(() => {}), detach: mock(() => {}) };
    const runtime = makeRuntime([{ kind: "text_delta", delta: "x" }, DONE_EVENT]);
    const harness = createCliHarness({ runtime, channel: makeChannel(), tui });

    await harness.runSinglePrompt("test");

    expect((tui.attach as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((tui.detach as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: missing done event
// ---------------------------------------------------------------------------

describe("createCliHarness — missing done event", () => {
  test("runSinglePrompt throws when engine stream has no done event", async () => {
    // Regression: previously returned { stopReason: "completed" } masking truncation
    const runtime = makeRuntime([{ kind: "text_delta", delta: "partial" }]);
    const harness = createCliHarness({ runtime, channel: makeChannel(), tui: null });

    await expect(harness.runSinglePrompt("test")).rejects.toThrow("truncated");
  });

  test("runInteractive throws when engine stream has no done event", async () => {
    // Regression: interactive mode previously swallowed truncated turns silently
    const controller = new AbortController();
    const truncatedRuntime: HarnessRuntime = {
      run: (_input) =>
        (async function* () {
          yield { kind: "text_delta", delta: "partial" } as EngineEvent;
          // no done event — simulates provider dropping the stream
        })(),
    };
    const channel = makeChannel();
    const harness = createCliHarness({
      runtime: truncatedRuntime,
      channel,
      tui: null,
      signal: controller.signal,
    });

    const done = harness.runInteractive();
    channel.triggerMessage("hi");
    await expect(done).rejects.toThrow("truncated");
  });
});
