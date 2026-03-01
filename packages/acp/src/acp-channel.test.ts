/**
 * Tests for the ACP server ChannelAdapter.
 */

import { describe, expect, test } from "bun:test";
import { createAcpChannel } from "./acp-channel.js";

describe("createAcpChannel", () => {
  test("returns adapter with correct name", () => {
    const channel = createAcpChannel();
    expect(channel.name).toBe("acp");
  });

  test("has correct capabilities", () => {
    const channel = createAcpChannel();
    expect(channel.capabilities.text).toBe(true);
    expect(channel.capabilities.images).toBe(false);
    expect(channel.capabilities.files).toBe(true);
    expect(channel.capabilities.buttons).toBe(false);
    expect(channel.capabilities.audio).toBe(false);
    expect(channel.capabilities.video).toBe(false);
    expect(channel.capabilities.threads).toBe(false);
  });

  test("onMessage stores handler and returns unsubscribe", () => {
    const channel = createAcpChannel();
    const handler = async () => {};
    const unsub = channel.onMessage(handler);
    expect(typeof unsub).toBe("function");
  });

  test("getApprovalHandler throws before connect", () => {
    const channel = createAcpChannel();
    expect(() => channel.getApprovalHandler()).toThrow("before connect()");
  });

  test("disconnect is safe to call before connect", async () => {
    const channel = createAcpChannel();
    // Should not throw
    await channel.disconnect();
  });

  test("accepts custom config", () => {
    const channel = createAcpChannel({
      agentInfo: { name: "test", version: "1.0" },
      backpressureLimit: 50,
      timeouts: { fsMs: 10_000 },
    });
    expect(channel.name).toBe("acp");
  });
});
