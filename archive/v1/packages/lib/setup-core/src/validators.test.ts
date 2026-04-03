import { describe, expect, test } from "bun:test";
import { isValidModel, isValidName, validateModel, validateName } from "./validators.js";

describe("isValidName", () => {
  test("accepts valid names", () => {
    expect(isValidName("my-agent")).toBe(true);
    expect(isValidName("agent123")).toBe(true);
    expect(isValidName("a")).toBe(true);
    expect(isValidName("my.agent_v2")).toBe(true);
    expect(isValidName("0-start-with-digit")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidName("")).toBe(false);
  });

  test("rejects uppercase", () => {
    expect(isValidName("MyAgent")).toBe(false);
    expect(isValidName("AGENT")).toBe(false);
  });

  test("rejects special characters", () => {
    expect(isValidName("my agent")).toBe(false);
    expect(isValidName("my@agent")).toBe(false);
    expect(isValidName("my/agent")).toBe(false);
  });

  test("rejects names starting with special chars", () => {
    expect(isValidName("-agent")).toBe(false);
    expect(isValidName(".agent")).toBe(false);
    expect(isValidName("_agent")).toBe(false);
  });

  test("rejects names longer than 214 chars", () => {
    expect(isValidName("a".repeat(214))).toBe(true);
    expect(isValidName("a".repeat(215))).toBe(false);
  });
});

describe("validateName", () => {
  test("returns undefined for valid names", () => {
    expect(validateName("my-agent")).toBeUndefined();
  });

  test("returns error for empty", () => {
    expect(validateName("")).toBe("Name cannot be empty");
  });

  test("returns error for too long", () => {
    expect(validateName("a".repeat(215))).toBe("Name must be 214 characters or fewer");
  });

  test("returns error for invalid chars", () => {
    expect(validateName("My Agent")).toBeDefined();
  });
});

describe("isValidModel", () => {
  test("accepts provider:model format", () => {
    expect(isValidModel("anthropic:claude-sonnet-4-5-20250929")).toBe(true);
    expect(isValidModel("openai:gpt-4o")).toBe(true);
    expect(isValidModel("a:b")).toBe(true);
  });

  test("rejects missing colon", () => {
    expect(isValidModel("gpt-4o")).toBe(false);
  });

  test("rejects colon at start", () => {
    expect(isValidModel(":model")).toBe(false);
  });

  test("rejects colon at end", () => {
    expect(isValidModel("provider:")).toBe(false);
  });
});

describe("validateModel", () => {
  test("returns undefined for valid", () => {
    expect(validateModel("anthropic:claude")).toBeUndefined();
  });

  test("returns error for empty", () => {
    expect(validateModel("")).toBe("Model cannot be empty");
  });

  test("returns error for missing provider", () => {
    expect(validateModel(":model")).toBe("Model must be in 'provider:model' format");
  });

  test("returns error for missing model name", () => {
    expect(validateModel("provider:")).toBe("Model name cannot be empty after provider");
  });
});
