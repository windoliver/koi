import { describe, expect, test } from "bun:test";
import * as payLocal from "../index.js";

describe("@koi/pay-local API surface", () => {
  test("exports createLocalPayLedger", () => {
    expect(typeof payLocal.createLocalPayLedger).toBe("function");
  });

  test("no unexpected exports", () => {
    const keys = Object.keys(payLocal).sort();
    expect(keys).toEqual(["createLocalPayLedger"]);
  });
});
