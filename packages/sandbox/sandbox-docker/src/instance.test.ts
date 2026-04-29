import { describe, expect, test } from "bun:test";
import { createDockerInstance } from "./instance.js";
import type { DockerContainer, DockerExecResult } from "./types.js";

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
});
