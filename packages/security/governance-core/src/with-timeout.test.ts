import { describe, expect, it } from "bun:test";
import { ApprovalTimeoutError, isApprovalTimeout, withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  it("resolves with the promise value when it settles first", async () => {
    const p = Promise.resolve(42);
    await expect(withTimeout(p, 1000)).resolves.toBe(42);
  });

  it("rejects with ApprovalTimeoutError when the timer fires first", async () => {
    const p = new Promise<number>((res) => setTimeout(() => res(1), 200));
    await expect(withTimeout(p, 10)).rejects.toBeInstanceOf(ApprovalTimeoutError);
  });

  it("isApprovalTimeout returns true only for ApprovalTimeoutError instances", () => {
    expect(isApprovalTimeout(new ApprovalTimeoutError("t"))).toBe(true);
    expect(isApprovalTimeout(new Error("other"))).toBe(false);
    expect(isApprovalTimeout("str")).toBe(false);
  });

  it("rejects when the abort signal fires first", async () => {
    const ctrl = new AbortController();
    const p = new Promise<number>((res) => setTimeout(() => res(1), 200));
    setTimeout(() => ctrl.abort(), 10);
    await expect(withTimeout(p, 1000, ctrl.signal)).rejects.toThrow();
  });

  it("rejects immediately when the abort signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = new Promise<number>((res) => setTimeout(() => res(1), 200));
    await expect(withTimeout(p, 1000, ctrl.signal)).rejects.toThrow();
  });

  it("does not leak timers after resolution", async () => {
    // Test completes quickly — a leaked timer would hang the runner
    const p = Promise.resolve("ok");
    await withTimeout(p, 10_000);
  });

  it("propagates underlying promise rejections as-is", async () => {
    const p = Promise.reject(new Error("underlying"));
    await expect(withTimeout(p, 1000)).rejects.toThrow("underlying");
  });
});
