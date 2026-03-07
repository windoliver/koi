/**
 * Self-test: runs the skill registry contract test suite against
 * the in-memory reference implementation.
 */

import { describe } from "bun:test";
import { createInMemorySkillRegistry } from "@koi/test-utils-mocks";
import { testSkillRegistryContract } from "./skill-registry-contract.js";

describe("SkillRegistryBackend (in-memory)", () => {
  testSkillRegistryContract({
    createRegistry: () => createInMemorySkillRegistry(),
  });
});
