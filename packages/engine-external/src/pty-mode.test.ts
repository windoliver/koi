import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { createTextDeltaParser } from "./parsers.js";
import type { PtySharedState } from "./pty-mode.js";
import { resolvePtyConfig, runPty } from "./pty-mode.js";

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

function createSharedState(): PtySharedState {
  return {
    outputHistory: [],
    currentProcess: undefined,
    disposed: false,
  };
}

describe("resolvePtyConfig", () => {
  test("uses defaults when no pty config provided", () => {
    const config = resolvePtyConfig(
      "echo",
      ["hi"],
      "/tmp",
      { PATH: "/usr/bin" },
      createTextDeltaParser(),
      300_000,
      0,
      undefined,
      undefined,
    );

    expect(config.idleThresholdMs).toBe(30_000);
    expect(config.ansiStrip).toBe(true);
    expect(config.cols).toBe(120);
    expect(config.rows).toBe(40);
    expect(config.promptPattern).toBeUndefined();
  });

  test("respects custom pty config values", () => {
    const config = resolvePtyConfig(
      "bash",
      [],
      "/home",
      { PATH: "/usr/bin" },
      createTextDeltaParser(),
      60_000,
      5_000,
      undefined,
      {
        idleThresholdMs: 10_000,
        ansiStrip: false,
        cols: 200,
        rows: 60,
        promptPattern: "\\$ $",
      },
    );

    expect(config.idleThresholdMs).toBe(10_000);
    expect(config.ansiStrip).toBe(false);
    expect(config.cols).toBe(200);
    expect(config.rows).toBe(60);
    expect(config.promptPattern).toBeInstanceOf(RegExp);
    expect(config.promptPattern?.source).toBe("\\$ $");
  });
});

describe("runPty — echo command", () => {
  test("echo produces text_delta events + done(completed)", async () => {
    const config = resolvePtyConfig(
      "echo",
      ["pty-test-output"],
      process.cwd(),
      { PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
      createTextDeltaParser(),
      10_000,
      0,
      undefined,
      { idleThresholdMs: 500, cols: 80, rows: 24 },
    );

    const shared = createSharedState();
    const events = await collectEvents(runPty(config, { kind: "text", text: "" }, shared));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    const allText = textDeltas.map((e) => (e.kind === "text_delta" ? e.delta : "")).join("");
    expect(allText).toContain("pty-test-output");

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("completed");
  }, 15_000);
});

describe("runPty — abort signal", () => {
  test("abort signal produces done(interrupted)", async () => {
    const controller = new AbortController();
    const config = resolvePtyConfig(
      "sh",
      ["-c", "sleep 30"],
      process.cwd(),
      { PATH: process.env.PATH ?? "" },
      createTextDeltaParser(),
      0,
      0,
      undefined,
      { idleThresholdMs: 60_000 },
    );

    // Abort after 200ms
    setTimeout(() => controller.abort(), 200);

    const shared = createSharedState();
    const events = await collectEvents(
      runPty(config, { kind: "text", text: "", signal: controller.signal }, shared),
    );

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("interrupted");
  }, 10_000);

  test("pre-aborted signal produces done(interrupted) immediately", async () => {
    const controller = new AbortController();
    controller.abort();

    const config = resolvePtyConfig(
      "echo",
      ["should-not-run"],
      process.cwd(),
      { PATH: process.env.PATH ?? "" },
      createTextDeltaParser(),
      10_000,
      0,
      undefined,
      { idleThresholdMs: 500 },
    );

    const shared = createSharedState();
    const events = await collectEvents(
      runPty(config, { kind: "text", text: "", signal: controller.signal }, shared),
    );

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("interrupted");
  });
});

describe("runPty — timeout", () => {
  test("overall timeout produces done(error)", async () => {
    const config = resolvePtyConfig(
      "sh",
      ["-c", "sleep 30"],
      process.cwd(),
      { PATH: process.env.PATH ?? "" },
      createTextDeltaParser(),
      300, // 300ms timeout
      0,
      undefined,
      { idleThresholdMs: 60_000 },
    );

    const shared = createSharedState();
    const events = await collectEvents(runPty(config, { kind: "text", text: "" }, shared));

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("error");
  }, 10_000);
});

describe("runPty — ANSI stripping", () => {
  test("strips ANSI from output when ansiStrip is true", async () => {
    const config = resolvePtyConfig(
      "sh",
      ["-c", "printf '\\033[31mred\\033[0m'"],
      process.cwd(),
      { PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
      createTextDeltaParser(),
      10_000,
      0,
      undefined,
      { idleThresholdMs: 500, ansiStrip: true },
    );

    const shared = createSharedState();
    const events = await collectEvents(runPty(config, { kind: "text", text: "" }, shared));

    const allText = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.delta : ""))
      .join("");

    // Should contain "red" without ANSI escape codes
    expect(allText).toContain("red");
    expect(allText).not.toContain("\x1b[");
  }, 15_000);
});

describe("runPty — idle detection", () => {
  test("idle detector fires on silence", async () => {
    const config = resolvePtyConfig(
      "sh",
      ["-c", "echo hello; sleep 30"],
      process.cwd(),
      { PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
      createTextDeltaParser(),
      0, // no overall timeout
      0,
      undefined,
      { idleThresholdMs: 500 },
    );

    const shared = createSharedState();
    const events = await collectEvents(runPty(config, { kind: "text", text: "" }, shared));

    const done = findDone(events);
    expect(done).toBeDefined();
    // Idle detector fires → completed
    expect(done?.output.stopReason).toBe("completed");

    const allText = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.delta : ""))
      .join("");
    expect(allText).toContain("hello");
  }, 15_000);
});

describe("runPty — history tracking", () => {
  test("output is recorded in shared history", async () => {
    const config = resolvePtyConfig(
      "echo",
      ["history-test"],
      process.cwd(),
      { PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
      createTextDeltaParser(),
      10_000,
      0,
      undefined,
      { idleThresholdMs: 500 },
    );

    const shared = createSharedState();
    await collectEvents(runPty(config, { kind: "text", text: "" }, shared));

    expect(shared.outputHistory.length).toBeGreaterThan(0);
    const fullHistory = shared.outputHistory.join("");
    expect(fullHistory).toContain("history-test");
  }, 15_000);
});

describe("runPty — spawn failure", () => {
  test("non-existent command produces done(error)", async () => {
    const config = resolvePtyConfig(
      "__nonexistent_pty_cmd_42__",
      [],
      process.cwd(),
      { PATH: process.env.PATH ?? "" },
      createTextDeltaParser(),
      10_000,
      0,
      undefined,
      undefined,
    );

    const shared = createSharedState();
    const events = await collectEvents(runPty(config, { kind: "text", text: "" }, shared));

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("error");
  });
});

describe("runPty — resume input", () => {
  test("resume input kind sends empty text", async () => {
    const config = resolvePtyConfig(
      "echo",
      ["resume-test"],
      process.cwd(),
      { PATH: process.env.PATH ?? "", TERM: "xterm-256color" },
      createTextDeltaParser(),
      10_000,
      0,
      undefined,
      { idleThresholdMs: 500 },
    );

    const shared = createSharedState();
    const events = await collectEvents(runPty(config, { kind: "resume" }, shared));

    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("completed");
  }, 15_000);
});
