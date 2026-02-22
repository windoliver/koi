import { describe, expect, test } from "bun:test";
import { createOsAdapter } from "./adapter.js";
import { restrictiveProfile } from "./profiles.js";

describe("createOsAdapter", () => {
  test("returns adapter with name 'os'", () => {
    const adapter = createOsAdapter();
    expect(adapter.name).toBe("os");
  });

  test("adapter.create returns a SandboxInstance", async () => {
    const adapter = createOsAdapter();
    const profile = restrictiveProfile();
    const instance = await adapter.create(profile);
    expect(typeof instance.exec).toBe("function");
    expect(typeof instance.readFile).toBe("function");
    expect(typeof instance.writeFile).toBe("function");
    expect(typeof instance.destroy).toBe("function");
  });

  test("destroy prevents further exec calls", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    await instance.destroy();
    expect(instance.exec("/bin/echo", ["hello"])).rejects.toThrow("destroyed");
  });

  test("destroy prevents further readFile calls", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    await instance.destroy();
    expect(instance.readFile("/dev/null")).rejects.toThrow("destroyed");
  });

  test("destroy prevents further writeFile calls", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    await instance.destroy();
    expect(instance.writeFile("/dev/null", new Uint8Array())).rejects.toThrow("destroyed");
  });

  test("destroy can be called multiple times safely", async () => {
    const adapter = createOsAdapter();
    const instance = await adapter.create(restrictiveProfile());
    await instance.destroy();
    await instance.destroy();
  });
});
