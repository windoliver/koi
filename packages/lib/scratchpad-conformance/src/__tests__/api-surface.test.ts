import { expect, test } from "bun:test";
import { describeScratchpadConformance } from "../index.js";

test("describeScratchpadConformance is exported as a callable", () => {
  expect(typeof describeScratchpadConformance).toBe("function");
});
