import { describe, expect, test } from "bun:test";
import { validateDockerConfig } from "./validate.js";

describe("validateDockerConfig", () => {
  test("returns error when no client and no socketPath defaults available", () => {
    const result = validateDockerConfig({ client: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAVAILABLE");
    }
  });

  test("uses provided client and applies image default", () => {
    const stubClient = {
      createContainer: async (): Promise<never> => {
        throw new Error("not implemented");
      },
    };
    const result = validateDockerConfig({ client: stubClient });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.image).toBe("ubuntu:22.04");
      expect(result.value.client).toBe(stubClient);
    }
  });

  test("preserves explicit image override", () => {
    const stubClient = {
      createContainer: async (): Promise<never> => {
        throw new Error("not implemented");
      },
    };
    const result = validateDockerConfig({ client: stubClient, image: "alpine:3.19" });
    expect(result.ok && result.value.image).toBe("alpine:3.19");
  });
});
