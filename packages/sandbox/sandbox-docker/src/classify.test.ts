import { describe, expect, test } from "bun:test";
import { classifyDockerExit } from "./classify.js";

describe("classifyDockerExit", () => {
  test("exitCode 137 → OOM-killed", () => {
    const e = classifyDockerExit({ exitCode: 137, stdout: "", stderr: "" });
    expect(e?.code).toBe("INTERNAL");
    expect(e?.context?.oomKilled).toBe(true);
  });

  test("exitCode 124 → TIMEOUT", () => {
    const e = classifyDockerExit({ exitCode: 124, stdout: "", stderr: "" });
    expect(e?.code).toBe("TIMEOUT");
  });

  test("exitCode 0 → undefined (no error)", () => {
    expect(classifyDockerExit({ exitCode: 0, stdout: "", stderr: "" })).toBeUndefined();
  });

  test("non-zero exit other than 124/137 → INTERNAL with oomKilled false and stderr truncated", () => {
    const e = classifyDockerExit({ exitCode: 1, stdout: "", stderr: "x".repeat(1000) });
    expect(e?.code).toBe("INTERNAL");
    expect(e?.context?.oomKilled).toBe(false);
    const stderr = e?.context?.stderr;
    expect(typeof stderr).toBe("string");
    if (typeof stderr === "string") expect(stderr.length).toBe(512);
  });
});
