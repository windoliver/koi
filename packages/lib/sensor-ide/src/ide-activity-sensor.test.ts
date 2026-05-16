import { describe, expect, test } from "bun:test";
import { createIdeActivitySensor } from "./ide-activity-sensor.js";

describe("createIdeActivitySensor", () => {
  test("measures typing speed from retained edit activity", () => {
    const sensor = createIdeActivitySensor({ now: () => 60_000 });

    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 30, timestamp: 0 });
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 30, timestamp: 60_000 });

    expect(sensor.snapshot().typingSpeedCharsPerMinute).toBe(60);
  });

  test("tracks latest diagnostic error rate by file", () => {
    const sensor = createIdeActivitySensor({ now: () => 10_000 });

    sensor.record({
      kind: "diagnostic",
      filePath: "/repo/a.ts",
      severity: "error",
      count: 2,
      timestamp: 1_000,
    });
    sensor.record({
      kind: "diagnostic",
      filePath: "/repo/b.ts",
      severity: "error",
      count: 4,
      timestamp: 2_000,
    });
    sensor.record({
      kind: "diagnostic",
      filePath: "/repo/a.ts",
      severity: "error",
      count: 1,
      timestamp: 3_000,
    });

    const snapshot = sensor.snapshot();
    expect(snapshot.errorCount).toBe(5);
    expect(snapshot.errorRatePerFile).toBe(2.5);
  });

  test("computes file-switch frequency from focus transitions", () => {
    const sensor = createIdeActivitySensor({ now: () => 60_000 });

    sensor.record({ kind: "file_focus", filePath: "/repo/a.ts", timestamp: 0 });
    sensor.record({ kind: "file_focus", filePath: "/repo/b.ts", timestamp: 30_000 });
    sensor.record({ kind: "file_focus", filePath: "/repo/c.ts", timestamp: 60_000 });

    expect(sensor.snapshot().fileSwitchesPerMinute).toBe(2);
  });

  test("detects flow state from sustained edits in one file", () => {
    const sensor = createIdeActivitySensor({
      now: () => 180_000,
      flowWindowMs: 180_000,
      minFlowEditEvents: 4,
      minFlowDurationMs: 120_000,
    });

    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 10, timestamp: 0 });
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 10, timestamp: 60_000 });
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 10, timestamp: 120_000 });
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 10, timestamp: 180_000 });

    expect(sensor.snapshot().flowState).toBe(true);
  });

  test("does not treat a rapid same-file edit burst as flow state", () => {
    const sensor = createIdeActivitySensor({
      now: () => 10_000,
      flowWindowMs: 10_000,
      minFlowEditEvents: 4,
      minFlowDurationMs: 60_000,
    });

    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 10, timestamp: 1_000 });
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 10, timestamp: 2_000 });
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 10, timestamp: 3_000 });
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 10, timestamp: 4_000 });

    expect(sensor.snapshot().flowState).toBe(false);
  });

  test("detects context switching from rapid file focus changes", () => {
    const sensor = createIdeActivitySensor({
      now: () => 30_000,
      contextSwitchWindowMs: 30_000,
      contextSwitchThreshold: 3,
    });

    sensor.record({ kind: "file_focus", filePath: "/repo/a.ts", timestamp: 0 });
    sensor.record({ kind: "file_focus", filePath: "/repo/b.ts", timestamp: 10_000 });
    sensor.record({ kind: "file_focus", filePath: "/repo/c.ts", timestamp: 20_000 });
    sensor.record({ kind: "file_focus", filePath: "/repo/d.ts", timestamp: 30_000 });

    expect(sensor.snapshot().contextSwitchDetected).toBe(true);
  });

  test("detects frustration from delete and undo bursts", () => {
    const sensor = createIdeActivitySensor({
      now: () => 20_000,
      frustrationWindowMs: 20_000,
      frustrationThreshold: 4,
    });

    sensor.record({ kind: "delete", filePath: "/repo/a.ts", chars: 8, timestamp: 1_000 });
    sensor.record({ kind: "undo", filePath: "/repo/a.ts", timestamp: 2_000 });
    sensor.record({ kind: "delete", filePath: "/repo/a.ts", chars: 4, timestamp: 3_000 });
    sensor.record({ kind: "undo", filePath: "/repo/a.ts", timestamp: 4_000 });

    expect(sensor.snapshot().frustrationDetected).toBe(true);
  });

  test("keeps a bounded recent activity event stream", () => {
    const sensor = createIdeActivitySensor({ now: () => 4_000, maxEvents: 3 });

    sensor.record({ kind: "file_focus", filePath: "/repo/a.ts", timestamp: 1_000 });
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 3, timestamp: 2_000 });
    sensor.record({ kind: "delete", filePath: "/repo/a.ts", chars: 1, timestamp: 3_000 });
    sensor.record({ kind: "undo", filePath: "/repo/a.ts", timestamp: 4_000 });

    expect(sensor.snapshot().recentEvents).toEqual([
      { kind: "edit", filePath: "/repo/a.ts", timestamp: 2_000 },
      { kind: "delete", filePath: "/repo/a.ts", timestamp: 3_000 },
      { kind: "undo", filePath: "/repo/a.ts", timestamp: 4_000 },
    ]);
  });

  test("streams accepted activity events to subscribers without exposing mutable state", () => {
    const sensor = createIdeActivitySensor({ now: () => 2_000 });
    const seen: unknown[] = [];

    const unsubscribe = sensor.subscribe((event) => {
      seen.push(event);
    });
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 3, timestamp: 2_000 });
    unsubscribe();
    sensor.record({ kind: "undo", filePath: "/repo/a.ts", timestamp: 3_000 });

    expect(seen).toEqual([
      { kind: "edit", filePath: "/repo/a.ts", insertedChars: 3, timestamp: 2_000 },
    ]);
  });

  test("retained metrics are insulated from caller mutation after record", () => {
    const sensor = createIdeActivitySensor({ now: () => 60_000 });
    const event = {
      kind: "edit",
      filePath: "/repo/a.ts",
      insertedChars: 30,
      timestamp: 0,
    } as const;

    sensor.record(event);
    (event as { insertedChars: number; filePath: string }).insertedChars = 10_000;
    (event as { insertedChars: number; filePath: string }).filePath = "/repo/mutated.ts";
    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 30, timestamp: 60_000 });

    const snapshot = sensor.snapshot();
    expect(snapshot.typingSpeedCharsPerMinute).toBe(60);
    expect(snapshot.activeFileCount).toBe(1);
  });

  test("snapshot ignores future-dated events until the clock reaches them", () => {
    let now = 10_000;
    const sensor = createIdeActivitySensor({ now: () => now });

    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 10, timestamp: 10_000 });
    sensor.record({
      kind: "edit",
      filePath: "/repo/a.ts",
      insertedChars: 10_000,
      timestamp: 70_000,
    });
    sensor.record({
      kind: "diagnostic",
      filePath: "/repo/future.ts",
      severity: "error",
      count: 7,
      timestamp: 70_000,
    });

    expect(sensor.snapshot()).toMatchObject({
      activeFileCount: 1,
      errorCount: 0,
      typingSpeedCharsPerMinute: 0,
      recentEvents: [{ kind: "edit", filePath: "/repo/a.ts", timestamp: 10_000 }],
    });

    now = 70_000;
    expect(sensor.snapshot()).toMatchObject({
      activeFileCount: 2,
      errorCount: 7,
      typingSpeedCharsPerMinute: 10_010,
    });
  });

  test("continues streaming when one subscriber throws", () => {
    const sensor = createIdeActivitySensor({ now: () => 2_000 });
    const seen: string[] = [];

    sensor.subscribe(() => {
      throw new Error("consumer failed");
    });
    sensor.subscribe((event) => {
      seen.push(event.kind);
    });

    sensor.record({ kind: "delete", filePath: "/repo/a.ts", chars: 1, timestamp: 2_000 });

    expect(seen).toEqual(["delete"]);
  });

  test("clear drops retained events without removing stream subscribers", () => {
    const sensor = createIdeActivitySensor({ now: () => 3_000 });
    const seen: string[] = [];

    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 3, timestamp: 1_000 });
    sensor.subscribe((event) => {
      seen.push(event.kind);
    });

    sensor.clear();
    sensor.record({ kind: "undo", filePath: "/repo/a.ts", timestamp: 3_000 });

    expect(sensor.snapshot().recentEvents).toEqual([
      { kind: "undo", filePath: "/repo/a.ts", timestamp: 3_000 },
    ]);
    expect(seen).toEqual(["undo"]);
  });

  test("read returns a user-model sensor signal", () => {
    const sensor = createIdeActivitySensor({ now: () => 60_000 });

    sensor.record({ kind: "edit", filePath: "/repo/a.ts", insertedChars: 12, timestamp: 0 });

    expect(sensor.name).toBe("ide");
    expect(sensor.read()).toEqual({
      kind: "sensor",
      source: "ide",
      values: sensor.snapshot(),
    });
  });
});
