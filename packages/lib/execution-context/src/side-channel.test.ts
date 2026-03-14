import { describe, expect, test } from "bun:test";
import { createSideChannel } from "./side-channel.js";

describe("createSideChannel", () => {
  test("stores and retrieves a value by key", () => {
    const channel = createSideChannel<number>("test");
    const key = {};
    channel.set(key, 42);
    expect(channel.get(key)).toBe(42);
  });

  test("returns undefined for unknown key", () => {
    const channel = createSideChannel<string>("test");
    expect(channel.get({})).toBeUndefined();
  });

  test("has() returns true for set keys", () => {
    const channel = createSideChannel<string>("test");
    const key = {};
    expect(channel.has(key)).toBe(false);
    channel.set(key, "hello");
    expect(channel.has(key)).toBe(true);
  });

  test("delete() removes an entry", () => {
    const channel = createSideChannel<string>("test");
    const key = {};
    channel.set(key, "value");
    expect(channel.delete(key)).toBe(true);
    expect(channel.get(key)).toBeUndefined();
    expect(channel.has(key)).toBe(false);
  });

  test("delete() returns false for missing key", () => {
    const channel = createSideChannel<string>("test");
    expect(channel.delete({})).toBe(false);
  });

  test("different keys are independent", () => {
    const channel = createSideChannel<string>("test");
    const keyA = {};
    const keyB = {};
    channel.set(keyA, "alpha");
    channel.set(keyB, "beta");
    expect(channel.get(keyA)).toBe("alpha");
    expect(channel.get(keyB)).toBe("beta");
  });

  test("different channels with same key are independent", () => {
    const channelA = createSideChannel<string>("a");
    const channelB = createSideChannel<number>("b");
    const key = {};
    channelA.set(key, "text");
    channelB.set(key, 99);
    expect(channelA.get(key)).toBe("text");
    expect(channelB.get(key)).toBe(99);
  });

  test("overwriting a value replaces it", () => {
    const channel = createSideChannel<string>("test");
    const key = {};
    channel.set(key, "first");
    channel.set(key, "second");
    expect(channel.get(key)).toBe("second");
  });

  test("exposes the channel name", () => {
    const channel = createSideChannel<unknown>("prompt-cache");
    expect(channel.name).toBe("prompt-cache");
  });
});
