import { describe } from "bun:test";
import { createInMemoryVersionIndex } from "@koi/test-utils-mocks";
import { testVersionIndexContract } from "../version-index-contract.js";

describe("VersionIndexBackend (in-memory)", () => {
  testVersionIndexContract({
    createIndex: () => createInMemoryVersionIndex(),
  });
});
