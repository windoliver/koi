import { describe, expect, test } from "bun:test";

import { createReconnectController } from "../reconnect.js";

describe("createReconnectController", () => {
  test("runs reconnect attempts with a single-flight guard", async () => {
    let attemptCalls = 0;
    const sleeps: number[] = [];

    const controller = createReconnectController({
      backoffMs: [1, 2, 3],
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
      attempt: async (): Promise<boolean> => {
        attemptCalls += 1;
        return attemptCalls >= 3;
      },
    });

    const [left, right] = await Promise.all([controller.run(), controller.run()]);
    expect(left).toBe(true);
    expect(right).toBe(true);
    expect(attemptCalls).toBe(3);
    expect(sleeps).toEqual([2, 3]);
  });
});
