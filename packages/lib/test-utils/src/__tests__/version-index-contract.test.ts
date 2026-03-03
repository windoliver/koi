import { describe } from "bun:test";
import { testVersionIndexContract } from "../version-index-contract.js";
import { createInMemoryVersionIndex } from "../version-index-memory.js";

describe("VersionIndexBackend (in-memory)", () => {
  testVersionIndexContract({
    createIndex: () => createInMemoryVersionIndex(),
  });
});
