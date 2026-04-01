import { createInMemoryForgeStore } from "@koi/forge-tools";
import { describeForgeStoreContract } from "./store-contract.js";

describeForgeStoreContract("InMemoryForgeStore", () => createInMemoryForgeStore());
