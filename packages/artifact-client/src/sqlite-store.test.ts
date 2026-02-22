import { describe } from "bun:test";
import { runArtifactStoreContractTests } from "./__tests__/store-contract.js";
import { createSqliteArtifactStore } from "./sqlite-store.js";

describe("SqliteArtifactStore", () => {
  runArtifactStoreContractTests(() => createSqliteArtifactStore({ dbPath: ":memory:" }));
});
