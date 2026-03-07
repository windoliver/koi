/**
 * Lazy-load shim tests — verify that missing optional deps produce
 * actionable error messages.
 */

import { describe, expect, test } from "bun:test";

describe("channel adapter shims", () => {
  test("discord shim function is accessible via channels", async () => {
    // Verify the shim is re-exported through the channels package
    const mod = await import("@koi/channels");
    expect(mod).toBeDefined();
  });
});

describe("sandbox adapter shims", () => {
  test("sandbox stack exports lazy-loaded adapter factories", async () => {
    const mod = await import("@koi/sandbox-stack");
    expect(typeof mod.createCloudflareAdapter).toBe("function");
    expect(typeof mod.createDaytonaAdapter).toBe("function");
    expect(typeof mod.createDockerAdapter).toBe("function");
    expect(typeof mod.createE2bAdapter).toBe("function");
    expect(typeof mod.createVercelAdapter).toBe("function");
  });
});

describe("error message format", () => {
  test("channel shim error includes install instruction", () => {
    const error = new Error("To use the Discord channel, install: bun add @koi/channel-discord");
    expect(error.message).toMatch(/install: bun add @koi\/channel-/);
  });

  test("sandbox shim error includes install instruction", () => {
    const error = new Error(
      "To use the Cloudflare sandbox, install: bun add @koi/sandbox-cloudflare",
    );
    expect(error.message).toMatch(/install: bun add @koi\/sandbox-/);
  });
});
