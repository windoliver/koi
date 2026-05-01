import { describe, expect, test } from "bun:test";
import { createFakeSandbox } from "./__tests__/fakes.js";
import { createE2bInstance } from "./instance.js";

describe("createE2bInstance", () => {
  test("exec joins command and args, passes env/cwd/timeout to SDK", async () => {
    const sdk = createFakeSandbox({
      runResult: { exitCode: 0, stdout: "hi\n", stderr: "" },
    });
    const instance = createE2bInstance(sdk);

    const result = await instance.exec("echo", ["hello world", "x"], {
      cwd: "/work",
      env: { FOO: "bar" },
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(sdk.runCalls).toHaveLength(1);
    const [call] = sdk.runCalls;
    expect(call?.cmd).toBe("echo 'hello world' 'x'");
    expect(call?.opts?.cwd).toBe("/work");
    expect(call?.opts?.envs).toEqual({ FOO: "bar" });
    expect(call?.opts?.timeoutMs).toBe(5000);
  });

  test("exec passes streaming callbacks through", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    const onStdout = (): void => undefined;
    const onStderr = (): void => undefined;
    await instance.exec("ls", [], { onStdout, onStderr });
    expect(sdk.runCalls[0]?.opts?.onStdout).toBe(onStdout);
    expect(sdk.runCalls[0]?.opts?.onStderr).toBe(onStderr);
  });

  test("exec returns exitCode 130 immediately when signal is pre-aborted", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    const ac = new AbortController();
    ac.abort();
    const result = await instance.exec("echo", ["hi"], { signal: ac.signal });
    expect(result.exitCode).toBe(130);
    expect(sdk.runCalls).toHaveLength(0);
  });

  test("exec maps SDK errors to non-zero result with stderr message", async () => {
    const sdk = createFakeSandbox({ runError: new Error("boom") });
    const instance = createE2bInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
    expect(result.timedOut).toBe(false);
  });

  test("exec flags timedOut when SDK error message mentions timeout", async () => {
    const sdk = createFakeSandbox({ runError: new Error("operation timed out") });
    const instance = createE2bInstance(sdk);
    const result = await instance.exec("ls", []);
    expect(result.timedOut).toBe(true);
  });

  test("readFile decodes string to bytes", async () => {
    const sdk = createFakeSandbox({ initialFiles: new Map([["/a", "hello"]]) });
    const instance = createE2bInstance(sdk);
    const bytes = await instance.readFile("/a");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  test("writeFile encodes bytes to string and stores via SDK", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await instance.writeFile("/b", new TextEncoder().encode("payload"));
    expect(sdk.files.store.get("/b")).toBe("payload");
  });

  test("destroy calls SDK kill and is idempotent", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await instance.destroy();
    await instance.destroy();
    expect(sdk.killed()).toBe(true);
  });

  test("exec/readFile/writeFile after destroy throw", async () => {
    const sdk = createFakeSandbox();
    const instance = createE2bInstance(sdk);
    await instance.destroy();
    await expect(instance.exec("ls", [])).rejects.toThrow(/destroyed/);
    await expect(instance.readFile("/a")).rejects.toThrow(/destroyed/);
    await expect(instance.writeFile("/a", new Uint8Array())).rejects.toThrow(/destroyed/);
  });
});
