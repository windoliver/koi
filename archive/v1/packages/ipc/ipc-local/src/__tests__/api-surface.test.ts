import { describe, expect, test } from "bun:test";
import * as ipcLocal from "../index.js";

describe("@koi/ipc-local API surface", () => {
  test("exports createLocalMailbox", () => {
    expect(typeof ipcLocal.createLocalMailbox).toBe("function");
  });

  test("exports createLocalMailboxRouter", () => {
    expect(typeof ipcLocal.createLocalMailboxRouter).toBe("function");
  });

  test("no unexpected exports", () => {
    const keys = Object.keys(ipcLocal).sort();
    expect(keys).toEqual(["createLocalMailbox", "createLocalMailboxRouter"]);
  });
});
