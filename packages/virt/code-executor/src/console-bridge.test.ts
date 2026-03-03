import { describe, expect, test } from "bun:test";
import { createConsoleBridge } from "./console-bridge.js";

describe("createConsoleBridge", () => {
  test("captures console.log via host function", async () => {
    const bridge = createConsoleBridge();
    const logFn = bridge.hostFunctions.get("__consoleLog");
    expect(logFn).toBeDefined();

    await logFn?.("hello world");
    const entries = bridge.entries();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("log");
    expect(entries[0]?.message).toBe("hello world");
  });

  test("captures console.error via host function", async () => {
    const bridge = createConsoleBridge();
    const errorFn = bridge.hostFunctions.get("__consoleError");

    await errorFn?.("error message");
    const entries = bridge.entries();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("error");
    expect(entries[0]?.message).toBe("error message");
  });

  test("captures console.warn via host function", async () => {
    const bridge = createConsoleBridge();
    const warnFn = bridge.hostFunctions.get("__consoleWarn");

    await warnFn?.("warning");
    const entries = bridge.entries();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("warn");
    expect(entries[0]?.message).toBe("warning");
  });

  test("captures multiple entries in order", async () => {
    const bridge = createConsoleBridge();
    const logFn = bridge.hostFunctions.get("__consoleLog") as
      | ((s: string) => Promise<string>)
      | undefined;
    const errorFn = bridge.hostFunctions.get("__consoleError") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(logFn).toBeDefined();
    expect(errorFn).toBeDefined();

    await logFn?.("first");
    await errorFn?.("second");
    await logFn?.("third");

    const entries = bridge.entries();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.level).toBe("log");
    expect(entries[1]?.level).toBe("error");
    expect(entries[2]?.level).toBe("log");
  });

  test("returns empty array when nothing captured", () => {
    const bridge = createConsoleBridge();
    expect(bridge.entries()).toHaveLength(0);
  });

  test("preamble defines console object", () => {
    const bridge = createConsoleBridge();
    expect(bridge.preamble).toContain("var console");
    expect(bridge.preamble).toContain("__consoleLog");
    expect(bridge.preamble).toContain("__consoleError");
    expect(bridge.preamble).toContain("__consoleWarn");
  });

  test("entries returns a copy (not mutable reference)", async () => {
    const bridge = createConsoleBridge();
    const logFn = bridge.hostFunctions.get("__consoleLog") as
      | ((s: string) => Promise<string>)
      | undefined;
    expect(logFn).toBeDefined();

    await logFn?.("first");
    const entries1 = bridge.entries();
    await logFn?.("second");
    const entries2 = bridge.entries();

    expect(entries1).toHaveLength(1);
    expect(entries2).toHaveLength(2);
  });

  test("provides three host functions", () => {
    const bridge = createConsoleBridge();
    expect(bridge.hostFunctions.size).toBe(3);
    expect(bridge.hostFunctions.has("__consoleLog")).toBe(true);
    expect(bridge.hostFunctions.has("__consoleError")).toBe(true);
    expect(bridge.hostFunctions.has("__consoleWarn")).toBe(true);
  });
});
