import { expect, test } from "bun:test";
import { describeWorkspaceConformance } from "../index.js";

test("describeWorkspaceConformance is exported as a callable", () => {
  expect(typeof describeWorkspaceConformance).toBe("function");
});
