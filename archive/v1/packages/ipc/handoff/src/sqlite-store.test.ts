import { describe } from "bun:test";
import { runHandoffStoreContractTests } from "./__tests__/store-contract.js";
import { createSqliteHandoffStore } from "./sqlite-store.js";

describe("SqliteHandoffStore", () => {
  runHandoffStoreContractTests(() => createSqliteHandoffStore({ dbPath: ":memory:" }));
});
