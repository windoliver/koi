import { describe, expect, test } from "bun:test";
import { createFakeSandbox } from "./__tests__/fakes.js";
import { createDaytonaInstance } from "./instance.js";

describe("createDaytonaInstance", () => {
  test("exec joins command, passes env/cwd/timeout to SDK", async () => {
    const sdk = createFakeSandbox({ runResult: { exitCode: 0, stdout: "hi", stderr: "" } });
    const instance = createDaytonaInstance(sdk);

    const result = await instance.exec("ls", ["-la", "/tmp foo"], {
      cwd: "/work",
      env: { K: "v" },
      timeoutMs: 1000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi");
    expect(sdk.runCalls).toHaveLength(1);
    const [call] = sdk.runCalls;
    expect(call?.cmd).toBe("ls '-la' '/tmp foo'");
    expect(call?.opts?.cwd).toBe("/work");
    expect(call?.opts?.envs).toEqual({ K: "v" });
    expect(call?.opts?.timeoutMs).toBe(1000);
  });

  test("exec returns 130 immediately when signal pre-aborted", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    const ac = new AbortController();
    ac.abort();
    const result = await instance.exec("ls", [], { signal: ac.signal });
    expect(result.exitCode).toBe(130);
    expect(sdk.runCalls).toHaveLength(0);
  });

  test("exec maps SDK errors to non-zero result", async () => {
    const sdk = createFakeSandbox({ runError: new Error("boom") });
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  test("exec flags timedOut when SDK error message mentions timeout", async () => {
    const sdk = createFakeSandbox({ runError: new Error("timed out") });
    const instance = createDaytonaInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.timedOut).toBe(true);
  });

  test("readFile / writeFile round-trip via SDK", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await instance.writeFile("/a", new TextEncoder().encode("payload"));
    const bytes = await instance.readFile("/a");
    expect(new TextDecoder().decode(bytes)).toBe("payload");
  });

  test("destroy closes SDK and is idempotent", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await instance.destroy();
    await instance.destroy();
    expect(sdk.closed()).toBe(true);
  });

  test("operations after destroy throw", async () => {
    const sdk = createFakeSandbox();
    const instance = createDaytonaInstance(sdk);
    await instance.destroy();
    await expect(instance.exec("ls", [])).rejects.toThrow(/destroyed/);
    await expect(instance.readFile("/a")).rejects.toThrow(/destroyed/);
    await expect(instance.writeFile("/a", new Uint8Array())).rejects.toThrow(/destroyed/);
  });
});
