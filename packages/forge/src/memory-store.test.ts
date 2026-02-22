import { runForgeStoreContractTests } from "./__tests__/store-contract.js";
import { createInMemoryForgeStore } from "./memory-store.js";

// Run the full contract test suite against InMemoryForgeStore
runForgeStoreContractTests(createInMemoryForgeStore);
