import { describe } from "bun:test";
import { runSnapshotChainStoreContractTests } from "@koi/test-utils";
import { createInMemorySnapshotChainStore } from "./memory-store.js";

interface TestData {
  readonly name: string;
  readonly value: number;
}

describe("InMemorySnapshotChainStore", () => {
  runSnapshotChainStoreContractTests<TestData>(
    () => createInMemorySnapshotChainStore<TestData>(),
    () => ({ name: "test", value: Math.random() }),
    () => ({ name: "different", value: -1 }),
  );
});
