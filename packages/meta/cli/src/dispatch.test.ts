import { afterEach, describe, expect, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
});

describe("runDispatch", () => {
  test("preserves non-Error command-loader diagnostic messages", async () => {
    mock.module("./registry.js", () => ({
      COMMAND_LOADERS: {
        start: () => {
          throw { message: "Cannot find module '@koi/example'" };
        },
      },
    }));

    const { runDispatch } = await import("./dispatch.js");
    const result = await runDispatch(["start"], "", "0.0.0");

    expect(result.kind).toBe("exit");
    if (result.kind !== "exit") throw new Error("expected exit result");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("failed to load command module");
    expect(result.stderr).toContain("Cannot find module '@koi/example'");
  });
});
