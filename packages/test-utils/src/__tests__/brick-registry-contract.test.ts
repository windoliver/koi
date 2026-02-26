/**
 * Runs the brick registry contract suite against the in-memory implementation.
 */

import { describe } from "bun:test";
import { testBrickRegistryContract } from "../brick-registry-contract.js";
import { createInMemoryBrickRegistry } from "../in-memory-brick-registry.js";

describe("InMemoryBrickRegistry", () => {
  testBrickRegistryContract({
    createRegistry: () => createInMemoryBrickRegistry(),
  });
});
