import { expect, test } from "bun:test";
import * as api from "../index.js";

test("public api surface", () => {
  expect(Object.keys(api).sort()).toMatchSnapshot();
});
