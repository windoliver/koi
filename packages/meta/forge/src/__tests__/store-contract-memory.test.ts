import { createInMemoryForgeStore } from "../memory-store.js";
import { describeForgeStoreContract } from "./store-contract.js";

describeForgeStoreContract("InMemoryForgeStore", () => createInMemoryForgeStore());
