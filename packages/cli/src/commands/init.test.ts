import { describe, expect, mock, test } from "bun:test";

// Mock @clack/prompts
mock.module("@clack/prompts", () => ({
  select: mock(() => Promise.resolve("minimal")),
  text: mock(() => Promise.resolve("test-agent")),
  multiselect: mock(() => Promise.resolve(["cli"])),
  confirm: mock(() => Promise.resolve(true)),
  intro: mock(() => {}),
  outro: mock(() => {}),
  cancel: mock(() => {}),
  isCancel: mock(() => false),
}));

const { runInit } = await import("./init.js");

describe("runInit", () => {
  test("is exported as a function", () => {
    expect(typeof runInit).toBe("function");
  });
});
