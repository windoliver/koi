import { describe } from "bun:test";
import { runArtifactStoreContractTests } from "./__tests__/store-contract.js";
import { createInMemoryArtifactStore } from "./memory-store.js";

describe("InMemoryArtifactStore", () => {
  runArtifactStoreContractTests(createInMemoryArtifactStore);
});
