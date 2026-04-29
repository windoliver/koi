import { describe, expect, test } from "bun:test";
import { validateDockerConfig } from "./validate.js";

describe("validateDockerConfig", () => {
  // Fix 5: missing client no longer returns UNAVAILABLE — falls back to default client
  test("returns ok: true when no client provided (falls back to default client)", () => {
    const result = validateDockerConfig({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.image).toBe("ubuntu:22.04");
      // client should be a non-null object (the default client)
      expect(typeof result.value.client).toBe("object");
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
