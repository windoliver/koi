import { describe, expect, test } from "bun:test";
import { createDockerInstance } from "./instance.js";
import type { DockerContainer, DockerExecOpts, DockerExecResult } from "./types.js";

function stubContainer(execResult: DockerExecResult): DockerContainer {
  return {
    id: "stub",
    exec: async (): Promise<DockerExecResult> => execResult,
    readFile: async (): Promise<Uint8Array> => new Uint8Array(),
    writeFile: async (): Promise<void> => {},
    stop: async (): Promise<void> => {},
    remove: async (): Promise<void> => {},
  };
}

describe("createDockerInstance", () => {
  test("exec returns SandboxAdapterResult with exit code + duration", async () => {
    const inst = createDockerInstance(stubContainer({ exitCode: 0, stdout: "hi", stderr: "" }));
    const r = await inst.exec("echo", ["hi"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("hi");
    expect(r.timedOut).toBe(false);
    expect(r.oomKilled).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("timedOut=true when exitCode is 124", async () => {
    const inst = createDockerInstance(stubContainer({ exitCode: 124, stdout: "", stderr: "" }));
    const r = await inst.exec("sleep", ["10"]);
    expect(r.timedOut).toBe(true);
    expect(r.oomKilled).toBe(false);
  });

  test("oomKilled=true when exitCode is 137", async () => {
    const inst = createDockerInstance(stubContainer({ exitCode: 137, stdout: "", stderr: "" }));
    const r = await inst.exec("big-process", []);
    expect(r.oomKilled).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  test("destroy stops and removes the container", async () => {
    let stopped = 0;
    let removed = 0;
    const inst = createDockerInstance({
      ...stubContainer({ exitCode: 0, stdout: "", stderr: "" }),
      stop: async (): Promise<void> => {
        stopped += 1;
      },
      remove: async (): Promise<void> => {
        removed += 1;
      },
    });
    await inst.destroy();
    expect(stopped).toBe(1);
    expect(removed).toBe(1);
  });

  test("destroy calls remove even when stop throws, then re-throws stop error", async () => {
    let removed = 0;
    const inst = createDockerInstance({
      ...stubContainer({ exitCode: 0, stdout: "", stderr: "" }),
      stop: async (): Promise<void> => {
        throw new Error("docker stop failed for stub");
      },
      remove: async (): Promise<void> => {
        removed += 1;
      },
    });
    await expect(inst.destroy()).rejects.toThrow("docker stop failed for stub");
    // remove must have been called despite stop throwing
    expect(removed).toBe(1);
  });

  test("readFile and writeFile proxy to the underlying container", async () => {
    let readPath = "";
    let wroteAt = "";
    let wroteBytes: Uint8Array | undefined;
    const inst = createDockerInstance({
      id: "stub",
      exec: async (): Promise<DockerExecResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
      readFile: async (path): Promise<Uint8Array> => {
        readPath = path;
        return new TextEncoder().encode("hello");
      },
      writeFile: async (path, content): Promise<void> => {
        wroteAt = path;
        wroteBytes = content;
      },
      stop: async (): Promise<void> => {},
      remove: async (): Promise<void> => {},
    });
    const got = await inst.readFile("/in.txt");
    expect(new TextDecoder().decode(got)).toBe("hello");
    expect(readPath).toBe("/in.txt");
    await inst.writeFile("/out.txt", new TextEncoder().encode("payload"));
    expect(wroteAt).toBe("/out.txt");
    expect(wroteBytes !== undefined && new TextDecoder().decode(wroteBytes)).toBe("payload");
  });

  // Fix 3: truncated flag propagates to SandboxAdapterResult
  test("truncated flag is propagated when DockerExecResult has truncated=true", async () => {
    const inst = createDockerInstance(
      stubContainer({ exitCode: 0, stdout: "big", stderr: "", truncated: true }),
    );
    const r = await inst.exec("cat", ["/big-file"]);
    expect(r.truncated).toBe(true);
  });

  // Fix 4: cwd is passed through to container.exec
  test("cwd option is passed to the underlying container.exec", async () => {
    let capturedOpts: DockerExecOpts | undefined;
    const container: DockerContainer = {
      id: "stub",
      exec: async (_cmd: string, opts?: DockerExecOpts): Promise<DockerExecResult> => {
        capturedOpts = opts;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readFile: async (): Promise<Uint8Array> => new Uint8Array(),
      writeFile: async (): Promise<void> => {},
      stop: async (): Promise<void> => {},
      remove: async (): Promise<void> => {},
    };
    const inst = createDockerInstance(container);
    await inst.exec("pwd", [], { cwd: "/workspace" });
    expect(capturedOpts?.cwd).toBe("/workspace");
  });

  // Fix 4: AbortSignal pre-aborted returns immediately with exitCode 130
  test("AbortSignal already aborted returns exitCode 130 without calling exec", async () => {
    let execCalled = false;
    const container: DockerContainer = {
      id: "stub",
      exec: async (): Promise<DockerExecResult> => {
        execCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readFile: async (): Promise<Uint8Array> => new Uint8Array(),
      writeFile: async (): Promise<void> => {},
      stop: async (): Promise<void> => {},
      remove: async (): Promise<void> => {},
    };
    const inst = createDockerInstance(container);
    const controller = new AbortController();
    controller.abort();
    const r = await inst.exec("echo", ["hi"], { signal: controller.signal });
    expect(r.exitCode).toBe(130);
    expect(execCalled).toBe(false);
  });

  // Fix 4: AbortSignal fired mid-flight returns exitCode 130
  test("AbortSignal aborted mid-flight causes exec to return with exitCode 130", async () => {
    const controller = new AbortController();
    // `let` justified: resolveExec is captured from the Promise constructor
    let resolveExec: (() => void) | undefined;
    const slowExecPromise = new Promise<void>((resolve) => {
      resolveExec = resolve;
    });

    const container: DockerContainer = {
      id: "stub",
      exec: async (_cmd, opts): Promise<DockerExecResult> => {
        // Simulate a real client: resolve with 130 when the signal aborts,
        // otherwise wait for external resolve. Mirrors runDockerExecBounded.
        const abortPromise = new Promise<DockerExecResult>((resolve) => {
          opts?.signal?.addEventListener(
            "abort",
            () => resolve({ exitCode: 130, stdout: "", stderr: "" }),
            { once: true },
          );
        });
        return Promise.race([
          slowExecPromise.then(() => ({ exitCode: 0, stdout: "", stderr: "" })),
          abortPromise,
        ]);
      },
      readFile: async (): Promise<Uint8Array> => new Uint8Array(),
      writeFile: async (): Promise<void> => {},
      stop: async (): Promise<void> => {},
      remove: async (): Promise<void> => {},
    };
    const inst = createDockerInstance(container);

    const execPromise = inst.exec("sleep", ["100"], { signal: controller.signal });

    // Abort while exec is in-flight
    controller.abort();

    const r = await execPromise;
    expect(r.exitCode).toBe(130);

    // Clean up: resolve the slow exec so we don't leave dangling promises
    if (resolveExec !== undefined) resolveExec();
  });

  // Fix 4: onStdout set → throws with descriptive error
  test("onStdout option throws descriptive error (streaming not supported)", async () => {
    const inst = createDockerInstance(stubContainer({ exitCode: 0, stdout: "", stderr: "" }));
    await expect(inst.exec("echo", ["hi"], { onStdout: (_chunk: string) => {} })).rejects.toThrow(
      "streaming callbacks (onStdout/onStderr) are not supported",
    );
  });

  // Fix 4: onStderr set → throws with descriptive error
  test("onStderr option throws descriptive error (streaming not supported)", async () => {
    const inst = createDockerInstance(stubContainer({ exitCode: 0, stdout: "", stderr: "" }));
    await expect(inst.exec("echo", ["hi"], { onStderr: (_chunk: string) => {} })).rejects.toThrow(
      "streaming callbacks (onStdout/onStderr) are not supported",
    );
  });
});
