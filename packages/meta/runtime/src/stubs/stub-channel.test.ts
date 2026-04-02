import { describe, expect, test } from "bun:test";
import { createStubChannel } from "./stub-channel.js";

describe("createStubChannel", () => {
  test("implements full ChannelAdapter contract", async () => {
    const channel = createStubChannel();

    expect(channel.name).toBe("stub");
    expect(channel.capabilities.text).toBe(true);

    // All methods are callable no-ops
    await channel.connect();
    await channel.send({ content: [{ kind: "text", text: "test" }] });
    await channel.disconnect();
  });

  test("onMessage returns unsubscribe function", () => {
    const channel = createStubChannel();
    const unsub = channel.onMessage(async () => {});
    expect(typeof unsub).toBe("function");
    unsub(); // Should not throw
  });
});
