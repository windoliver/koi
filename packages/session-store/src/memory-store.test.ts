import { describe } from "bun:test";
import { runSessionPersistenceContractTests } from "./__tests__/store-contract.js";
import { createInMemorySessionPersistence } from "./memory-store.js";

describe("InMemorySessionPersistence", () => {
  runSessionPersistenceContractTests(() =>
    createInMemorySessionPersistence({ maxCheckpointsPerAgent: 3 }),
  );
});
