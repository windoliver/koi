import { describe, expect, test } from "bun:test";
import { runDispatch } from "./dispatch.js";

describe("runDispatch", () => {
  test("preserves non-Error command-loader diagnostic messages", async () => {
    const result = await runDispatch(["start"], "", "0.0.0", {
      start: () => {
        throw { message: "Cannot find module '@koi/example'" };
      },
    });

    expect(result.kind).toBe("exit");
    if (result.kind !== "exit") throw new Error("expected exit result");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("failed to load command module");
    expect(result.stderr).toContain("Cannot find module '@koi/example'");
  });
});
