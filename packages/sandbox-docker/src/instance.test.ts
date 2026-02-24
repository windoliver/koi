import { describe, expect, mock, test } from "bun:test";
import { createDockerInstance } from "./instance.js";
import type { DockerNetworkConfig } from "./network.js";
import type { DockerContainer } from "./types.js";

function createMockContainer(overrides?: Partial<DockerContainer>): DockerContainer {
  return {
    id: "test-container-123",
    exec: mock(() => Promise.resolve({ exitCode: 0, stdout: "output", stderr: "" })),
    readFile: mock(() => Promise.resolve("file content")),
    writeFile: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    remove: mock(() => Promise.resolve()),
    ...overrides,
  };
}

const NO_NETWORK: DockerNetworkConfig = {
  networkMode: "none",
  capAdd: [],
  iptablesSetupScript: undefined,
};

describe("createDockerInstance", () => {
  test("exec runs command and returns result", async () => {
    const container = createMockContainer();
    const instance = createDockerInstance(container, NO_NETWORK);

    const result = await instance.exec("echo", ["hello"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("output");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.oomKilled).toBe(false);
    expect(container.exec).toHaveBeenCalled();

    await instance.destroy();
  });

  test("exec joins command and shell-escapes args", async () => {
    const execFn = mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }));
    const container = createMockContainer({ exec: execFn });
    const instance = createDockerInstance(container, NO_NETWORK);

    await instance.exec("ls", ["-la", "/tmp"]);

    expect(execFn).toHaveBeenCalledWith("ls '-la' '/tmp'", expect.anything());

    await instance.destroy();
  });

  test("exec shell-escapes args with special characters", async () => {
    const execFn = mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }));
    const container = createMockContainer({ exec: execFn });
    const instance = createDockerInstance(container, NO_NETWORK);

    await instance.exec("echo", ["hello; rm -rf /"]);

    expect(execFn).toHaveBeenCalledWith("echo 'hello; rm -rf /'", expect.anything());

    await instance.destroy();
  });

  test("exec passes env and stdin options", async () => {
    const execFn = mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }));
    const container = createMockContainer({ exec: execFn });
    const instance = createDockerInstance(container, NO_NETWORK);

    await instance.exec("cmd", [], {
      env: { FOO: "bar" },
      stdin: "input data",
    });

    expect(execFn).toHaveBeenCalledWith(
      "cmd",
      expect.objectContaining({
        env: { FOO: "bar" },
        stdin: "input data",
      }),
    );

    await instance.destroy();
  });

  test("exec calls streaming callbacks", async () => {
    const container = createMockContainer({
      exec: mock(() => Promise.resolve({ exitCode: 0, stdout: "chunk1", stderr: "err1" })),
    });
    const instance = createDockerInstance(container, NO_NETWORK);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    await instance.exec("cmd", [], {
      onStdout: (c) => stdoutChunks.push(c),
      onStderr: (c) => stderrChunks.push(c),
    });

    expect(stdoutChunks).toEqual(["chunk1"]);
    expect(stderrChunks).toEqual(["err1"]);

    await instance.destroy();
  });

  test("exec handles timeout errors", async () => {
    const container = createMockContainer({
      exec: mock(() => Promise.reject(new Error("Request timeout"))),
    });
    const instance = createDockerInstance(container, NO_NETWORK);

    const result = await instance.exec("sleep", ["100"]);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);

    await instance.destroy();
  });

  test("exec handles OOM errors", async () => {
    const container = createMockContainer({
      exec: mock(() => Promise.reject(new Error("Out of memory"))),
    });
    const instance = createDockerInstance(container, NO_NETWORK);

    const result = await instance.exec("alloc", []);
    expect(result.oomKilled).toBe(true);

    await instance.destroy();
  });

  test("applies iptables script on first exec when configured", async () => {
    const execCalls: string[] = [];
    const writeCalls: Array<{ path: string; content: string }> = [];
    const execFn = mock((cmd: string) => {
      execCalls.push(cmd);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    });
    const writeFn = mock((path: string, content: string) => {
      writeCalls.push({ path, content });
      return Promise.resolve();
    });
    const container = createMockContainer({ exec: execFn, writeFile: writeFn });

    const networkConfig: DockerNetworkConfig = {
      networkMode: "bridge",
      capAdd: ["NET_ADMIN"],
      iptablesSetupScript: "iptables -P OUTPUT DROP",
    };

    const instance = createDockerInstance(container, networkConfig);

    await instance.exec("echo", ["hello"]);
    // First: writes script to container, then executes it, then runs user command
    expect(writeCalls[0]?.path).toBe("/tmp/.koi-iptables-setup.sh");
    expect(writeCalls[0]?.content).toBe("iptables -P OUTPUT DROP");
    expect(execCalls[0]).toBe("sh /tmp/.koi-iptables-setup.sh");
    expect(execCalls[1]).toBe("echo 'hello'");

    // Second exec should NOT re-apply iptables
    await instance.exec("echo", ["world"]);
    expect(execCalls.length).toBe(3);
    expect(execCalls[2]).toBe("echo 'world'");
    expect(writeCalls.length).toBe(1);

    await instance.destroy();
  });

  test("readFile returns file content as Uint8Array", async () => {
    const container = createMockContainer();
    const instance = createDockerInstance(container, NO_NETWORK);

    const content = await instance.readFile("/test.txt");
    expect(new TextDecoder().decode(content)).toBe("file content");

    await instance.destroy();
  });

  test("writeFile sends content to container", async () => {
    const container = createMockContainer();
    const instance = createDockerInstance(container, NO_NETWORK);

    await instance.writeFile("/test.txt", new TextEncoder().encode("hello"));
    expect(container.writeFile).toHaveBeenCalledWith("/test.txt", "hello");

    await instance.destroy();
  });

  test("destroy calls stop and remove", async () => {
    const container = createMockContainer();
    const instance = createDockerInstance(container, NO_NETWORK);

    await instance.destroy();
    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledTimes(1);
  });

  test("destroy calls remove even if stop fails", async () => {
    const container = createMockContainer({
      stop: mock(() => Promise.reject(new Error("stop failed"))),
    });
    const instance = createDockerInstance(container, NO_NETWORK);

    await expect(instance.destroy()).rejects.toThrow("stop failed");
    expect(container.remove).toHaveBeenCalledTimes(1);
  });

  test("throws after destroy for exec", async () => {
    const container = createMockContainer();
    const instance = createDockerInstance(container, NO_NETWORK);

    await instance.destroy();
    expect(() => instance.exec("cmd", [])).toThrow("docker: cannot call exec() after destroy()");
  });

  test("throws after destroy for readFile", async () => {
    const container = createMockContainer();
    const instance = createDockerInstance(container, NO_NETWORK);

    await instance.destroy();
    expect(() => instance.readFile("/test")).toThrow(
      "docker: cannot call readFile() after destroy()",
    );
  });

  test("throws after destroy for writeFile", async () => {
    const container = createMockContainer();
    const instance = createDockerInstance(container, NO_NETWORK);

    await instance.destroy();
    expect(() => instance.writeFile("/test", new Uint8Array())).toThrow(
      "docker: cannot call writeFile() after destroy()",
    );
  });
});
