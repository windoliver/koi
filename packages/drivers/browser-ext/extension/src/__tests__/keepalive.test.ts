import { describe, expect, test } from "bun:test";
import { createKeepalive } from "../keepalive.js";
import { installChromeStub } from "./chrome-stub.js";

describe("keepalive", () => {
  test("alarm callback reconnects", async () => {
    installChromeStub();
    let reconnects = 0;
    const keepalive = createKeepalive({
      ensureConnected: async () => {
        reconnects += 1;
      },
      sendControlFrame: () => undefined,
    });

    await keepalive.handleAlarm({ name: "koi-keepalive", scheduledTime: Date.now() });
    expect(reconnects).toBe(1);
  });
});
