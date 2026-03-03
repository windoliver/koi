import { describe } from "bun:test";
import { runHandoffStoreContractTests } from "./__tests__/store-contract.js";
import { createInMemoryHandoffStore } from "./store.js";

describe("InMemoryHandoffStore", () => {
  runHandoffStoreContractTests(() => createInMemoryHandoffStore());
});
