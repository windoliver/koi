import { describe, expect, test } from "bun:test";
import * as scratchpadLocal from "../index.js";

describe("@koi/scratchpad-local API surface", () => {
  test("exports createLocalScratchpad", () => {
    expect(typeof scratchpadLocal.createLocalScratchpad).toBe("function");
  });

  test("no unexpected exports", () => {
    const keys = Object.keys(scratchpadLocal).sort();
    expect(keys).toEqual(["createLocalScratchpad"]);
  });
});
