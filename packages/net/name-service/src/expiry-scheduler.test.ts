import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ForgeScope } from "@koi/core";
import { createExpiryScheduler, type ExpiryScheduler } from "./expiry-scheduler.js";

describe("createExpiryScheduler", () => {
  let scheduler: ExpiryScheduler;
  const expired: Array<{ name: string; scope: ForgeScope }> = [];
  const onExpired = mock((name: string, scope: ForgeScope) => {
    expired.push({ name, scope });
  });

  beforeEach(() => {
    expired.length = 0;
    onExpired.mockClear();
    scheduler = createExpiryScheduler(onExpired);
  });

  afterEach(() => {
    scheduler.dispose();
  });

  test("fires callback after TTL elapses", async () => {
    scheduler.schedule("reviewer", "agent", 50);

    // Not fired yet
    expect(expired).toHaveLength(0);

    // Wait for timer to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(expired).toHaveLength(1);
    expect(expired[0]).toEqual({ name: "reviewer", scope: "agent" });
  });

  test("cancel prevents callback from firing", async () => {
    scheduler.schedule("reviewer", "agent", 50);
    scheduler.cancel("reviewer", "agent");

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(expired).toHaveLength(0);
  });

  test("cancel is no-op for unknown key", () => {
    // Should not throw
    scheduler.cancel("nonexistent", "agent");
  });

  test("schedule replaces existing timer", async () => {
    scheduler.schedule("reviewer", "agent", 30);
    scheduler.schedule("reviewer", "agent", 150);

    // After 60ms, the first timer would have fired if not replaced
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(expired).toHaveLength(0);

    // After 200ms, the replacement timer fires
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(expired).toHaveLength(1);
  });

  test("dispose clears all timers", async () => {
    scheduler.schedule("a", "agent", 50);
    scheduler.schedule("b", "zone", 50);
    scheduler.schedule("c", "global", 50);

    scheduler.dispose();

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(expired).toHaveLength(0);
  });

  test("multiple records fire independently", async () => {
    scheduler.schedule("fast", "agent", 30);
    scheduler.schedule("slow", "agent", 80);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(expired).toHaveLength(1);
    expect(expired[0]?.name).toBe("fast");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(expired).toHaveLength(2);
    expect(expired[1]?.name).toBe("slow");
  });
});
