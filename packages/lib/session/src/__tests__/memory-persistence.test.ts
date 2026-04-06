import { describe } from "bun:test";
import { createInMemorySessionPersistence } from "../persistence/memory-store.js";
import { runSessionPersistenceContractTests } from "./contracts/session-persistence-contract.js";

describe("InMemorySessionPersistence", () => {
  runSessionPersistenceContractTests(() => createInMemorySessionPersistence());
});
