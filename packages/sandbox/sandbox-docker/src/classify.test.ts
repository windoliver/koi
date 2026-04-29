import { describe, expect, test } from "bun:test";
import { classifyDockerExit } from "./classify.js";

describe("classifyDockerExit", () => {
  test("exitCode 137 → OOM-killed", () => {
    const e = classifyDockerExit({ exitCode: 137, stdout: "", stderr: "" });
    expect(e?.code).toBe("INTERNAL");
    expect(e?.context?.["oomKilled"]).toBe(true);
  });

  test("exitCode 124 → TIMEOUT", () => {
    const e = classifyDockerExit({ exitCode: 124, stdout: "", stderr: "" });
    expect(e?.code).toBe("TIMEOUT");
  });

  test("exitCode 0 → undefined (no error)", () => {
    expect(classifyDockerExit({ exitCode: 0, stdout: "", stderr: "" })).toBeUndefined();
  });
});
