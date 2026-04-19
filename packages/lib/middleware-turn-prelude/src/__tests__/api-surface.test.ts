import { describe, expect, test } from "bun:test";
import * as api from "../index.js";

describe("@koi/middleware-turn-prelude API surface", () => {
  test("exports are stable", () => {
    expect(Object.keys(api).sort()).toEqual(["buildPreludeMessage", "createTurnPreludeMiddleware"]);
  });
});
