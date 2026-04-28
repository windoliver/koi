import { describe, expect, test } from "bun:test";
import { validateWorkerIpcMessage } from "./worker-ipc.js";

describe("validateWorkerIpcMessage", () => {
  test("accepts heartbeat envelope", () => {
    const result = validateWorkerIpcMessage({ koi: "heartbeat" });
    expect(result.ok).toBe(true);
  });

  test("accepts terminate envelope with optional reason", () => {
    expect(validateWorkerIpcMessage({ koi: "terminate" }).ok).toBe(true);
    expect(validateWorkerIpcMessage({ koi: "terminate", reason: "shutdown" }).ok).toBe(true);
  });

  test("accepts engine-event with opaque event payload", () => {
    const result = validateWorkerIpcMessage({
      koi: "engine-event",
      event: { kind: "done", output: { text: "hi" } },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects engine-event missing event field", () => {
    const result = validateWorkerIpcMessage({ koi: "engine-event" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("event");
  });

  test("accepts result with integer exitCode + optional output", () => {
    expect(validateWorkerIpcMessage({ koi: "result", exitCode: 0 }).ok).toBe(true);
    expect(validateWorkerIpcMessage({ koi: "result", exitCode: 1, output: { bytes: 10 } }).ok).toBe(
      true,
    );
  });

  test("rejects result with non-integer exitCode", () => {
    expect(validateWorkerIpcMessage({ koi: "result", exitCode: 0.5 }).ok).toBe(false);
    expect(validateWorkerIpcMessage({ koi: "result", exitCode: "0" }).ok).toBe(false);
    expect(validateWorkerIpcMessage({ koi: "result" }).ok).toBe(false);
  });

  test("accepts message with opaque payload", () => {
    const result = validateWorkerIpcMessage({
      koi: "message",
      payload: { from: "sibling-a", data: [1, 2, 3] },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects unknown kind", () => {
    const result = validateWorkerIpcMessage({ koi: "unknown-kind" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("unknown kind");
  });

  test("rejects non-object input", () => {
    expect(validateWorkerIpcMessage(null).ok).toBe(false);
    expect(validateWorkerIpcMessage(undefined).ok).toBe(false);
    expect(validateWorkerIpcMessage("heartbeat").ok).toBe(false);
    expect(validateWorkerIpcMessage(42).ok).toBe(false);
  });

  test("rejects object missing koi discriminator", () => {
    const result = validateWorkerIpcMessage({ foo: "bar" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("koi");
  });
});
