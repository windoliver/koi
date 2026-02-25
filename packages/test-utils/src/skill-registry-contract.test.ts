/**
 * Self-test: runs the skill registry contract test suite against
 * the in-memory reference implementation.
 */

import { describe } from "bun:test";
import { testSkillRegistryContract } from "./skill-registry-contract.js";
import { createInMemorySkillRegistry } from "./skill-registry-memory.js";

describe("SkillRegistryBackend (in-memory)", () => {
  testSkillRegistryContract({
    createRegistry: () => createInMemorySkillRegistry(),
  });
});
