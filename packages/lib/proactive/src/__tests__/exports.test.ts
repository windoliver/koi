import { describe, expect, test } from "bun:test";
import {
  createGovernanceSignalSource,
  createGroveSignalSource,
  createNexusSignalSource,
} from "../index.js";

describe("@koi/proactive exports", () => {
  test("re-exports system signal source factories", () => {
    expect(typeof createGovernanceSignalSource).toBe("function");
    expect(typeof createGroveSignalSource).toBe("function");
    expect(typeof createNexusSignalSource).toBe("function");
  });
});
