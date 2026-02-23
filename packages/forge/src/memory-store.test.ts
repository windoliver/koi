import { runForgeStoreContractTests } from "@koi/test-utils";
import { createInMemoryForgeStore } from "./memory-store.js";

// Run the full contract test suite against InMemoryForgeStore
runForgeStoreContractTests(createInMemoryForgeStore);
