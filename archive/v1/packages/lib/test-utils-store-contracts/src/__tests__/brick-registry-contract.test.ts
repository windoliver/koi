/**
 * Runs the brick registry contract suite against the in-memory implementation.
 */

import { describe } from "bun:test";
import { createInMemoryBrickRegistry } from "@koi/test-utils-mocks";
import { testBrickRegistryContract } from "../brick-registry-contract.js";

describe("InMemoryBrickRegistry", () => {
  testBrickRegistryContract({
    createRegistry: () => createInMemoryBrickRegistry(),
  });
});
