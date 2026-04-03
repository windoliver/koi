import { describe, expect, test } from "bun:test";
import { processConfirmKey } from "./ConfirmDialog.js";

describe("processConfirmKey", () => {
  test("'y' returns confirm", () => {
    expect(processConfirmKey("y")).toBe("confirm");
  });

  test("'return' returns confirm", () => {
    expect(processConfirmKey("return")).toBe("confirm");
  });

  test("'n' returns cancel", () => {
    expect(processConfirmKey("n")).toBe("cancel");
  });

  test("'escape' returns cancel", () => {
    expect(processConfirmKey("escape")).toBe("cancel");
  });

  test("unknown key returns null (focus trap swallows)", () => {
    expect(processConfirmKey("x")).toBeNull();
    expect(processConfirmKey("a")).toBeNull();
    expect(processConfirmKey("tab")).toBeNull();
    expect(processConfirmKey("space")).toBeNull();
  });
});
